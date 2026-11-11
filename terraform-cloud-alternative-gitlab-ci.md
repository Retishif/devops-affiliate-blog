# How to Build a Production-Grade Terraform Cloud Alternative Using GitLab CI

## 1. The Real Cost of Infrastructure Automation Platforms

Terraform Cloud, now branded HCP Terraform, bills on resources under management (RUM). This model punishes the way mature infrastructure actually looks. A single VPC module can fan out into dozens of billable resources: route table associations, security group rules, IAM policy attachments, DNS records. A team that manages 40 "things" in its architecture diagram can easily manage 4,000 in state. Check the current price sheet against your own `terraform state list | wc -l` before assuming the numbers work for you.

The licensing context has made this worse:

- **August 2023:** HashiCorp moved Terraform from MPL 2.0 to the Business Source License 1.1. Internal use is still permitted, but the license restricts offering competing products, and legal teams now review it.
- **OpenTofu:** The community fork under the Linux Foundation is MPL 2.0 and a drop-in replacement for most workflows. Everything in this article works with it by swapping the binary and image.
- **IBM's acquisition of HashiCorp:** The deal closed in 2025. Whatever you think of it, pricing and packaging decisions now sit inside a much larger enterprise portfolio, and you should plan for them to change.

None of this makes HCP Terraform a bad product. It makes it a **line item that scales with infrastructure size rather than team size**, and that is the pattern that drives teams to look for alternatives.

GitLab CI already provides most of what you are paying a wrapper for:

| HCP Terraform capability | GitLab-native equivalent |
|---|---|
| Remote state with locking | GitLab Managed Terraform State (HTTP backend) |
| State versioning | Built-in state version history |
| Remote runs / queued runs | CI pipelines + `resource_group` |
| VCS-driven plan on PR | Merge request pipelines |
| Run approvals | Protected environments + MR approval rules |
| Private module registry | GitLab Terraform Module Registry |
| Workload identity | `id_tokens` (OIDC) |
| Drift detection (assessments) | Scheduled pipeline with `plan -detailed-exitcode` (section 4) |

Here is what you give up:

- **Sentinel / managed policy sets:** Replace them with OPA/Conftest or Checkov as an extra job in the `validate` stage.
- **Run tasks and cost estimation UI:** Infracost covers cost estimation in a CI job.
- **A purpose-built run UI:** You get pipeline views instead.

On gitlab.com, CI compute minutes are metered, but jobs on your own runners do not consume them. Self-hosted GitLab has no such limit. The cost of this setup is the runner host and some object storage, covered in section 5.

## 2. The Architectural Design: GitLab Managed Terraform State

GitLab Managed Terraform State is a standard implementation of Terraform's [`http` backend](https://developer.hashicorp.com/terraform/language/backend/http) protocol. There is no custom provider or plugin. Terraform talks to a REST endpoint scoped to your project:

```
https://<gitlab-host>/api/v4/projects/<project_id>/terraform/state/<state_name>
```

The protocol uses four operations:

| Operation | Method | Endpoint | Purpose |
|---|---|---|---|
| Read state | `GET` | `/terraform/state/<name>` | Fetch the latest state version |
| Write state | `POST` | `/terraform/state/<name>` | Store a new state version |
| Lock | `POST` | `/terraform/state/<name>/lock` | Acquire an exclusive lock (JSON body with lock ID, operation, owner) |
| Unlock | `DELETE` | `/terraform/state/<name>/lock` | Release the lock |

Terraform acquires the lock before reading state for any operation that can write. If a lock already exists, GitLab rejects the request with a conflict-class status (409 or 423). Terraform's HTTP backend treats both as "lock held," prints the holder's lock metadata (who, which operation, when), and either waits (`-lock-timeout`) or fails. Two overlapping pipelines therefore cannot both mutate the same state, regardless of how the jobs were scheduled.

You get two independent layers of mutual exclusion:

1. **State lock (Terraform-level):** Protects the state file itself. It is enforced server-side by GitLab.
2. **`resource_group` (CI-level):** Serializes *jobs*, so a second `apply` job queues instead of starting and failing on the lock.

Saved plans add a third safeguard. If state changed between `plan` and `apply`, Terraform rejects the plan as stale. A manual gate that sits for two hours cannot apply an outdated diff.

```
 Developer
    │  git push / open MR
    ▼
┌──────────────────────────── GitLab ─────────────────────────────┐
│                                                                 │
│  MR Pipeline                    Main Pipeline (post-merge)      │
│  ┌────────────────┐             ┌────────────────┐              │
│  │ fmt / validate │             │ fmt / validate │              │
│  │ tflint         │             │ tflint         │              │
│  ├────────────────┤             ├────────────────┤              │
│  │ plan           │             │ plan           │              │
│  │ (-lock=false)  │             │ (locks state)  │              │
│  └────────────────┘             ├────────────────┤              │
│                                 │ apply [manual] │              │
│                                 │ protected env  │              │
│                                 └───────┬────────┘              │
│                                         │                       │
│   ┌─────────────────────────────────────▼──────────────────┐    │
│   │  Managed Terraform State (HTTP backend)                │    │
│   │  GET/POST state · POST/DELETE lock · versioned · enc.  │    │
│   └────────────────────────────────────────────────────────┘    │
└────────────────┬────────────────────────────────────────────────┘
                 │ job dispatched
                 ▼
      ┌─────────────────────┐   OIDC JWT    ┌──────────────────┐
      │ Self-hosted Runner  │──────────────▶│ Cloud IAM (STS)  │
      │ (Docker / K8s exec) │◀──────────────│ short-lived creds│
      └─────────┬───────────┘               └──────────────────┘
                │ terraform apply
                ▼
         Cloud provider APIs
```

Operational notes:

- **Authentication:** Inside pipelines, the backend authenticates with username `gitlab-ci-token` and the `CI_JOB_TOKEN` as the password. No static state credentials exist anywhere. Writing state through the job token requires the Maintainer role for the user who triggered the job, and reading requires Developer. Confirm against your GitLab version's docs.
- **Encryption:** GitLab stores state encrypted at rest. State files frequently contain secrets, so this matters.
- **Stuck locks:** If a runner is killed mid-apply, the lock persists. Release it from the project's Terraform states page (Operate → Terraform states) or with `terraform force-unlock <LOCK_ID>`. Verify that nothing is still running before you do.
- **Backend config:** The backend block stays empty. All connection details come from `TF_HTTP_*` environment variables, so the same code works locally and in CI.

```hcl
# infra/backend.tf
terraform {
  backend "http" {}
}
```

## 3. The Implementation: Production-Grade `.gitlab-ci.yml`

The pipeline has three stages, plus an `ops` stage for scheduled jobs used in later sections. It assumes this layout:

```
.
├── .gitlab-ci.yml
└── infra/
    ├── backend.tf
    ├── main.tf
    └── .terraform.lock.hcl   # committed
```

Required CI/CD variables (Settings → CI/CD → Variables):

| Variable | Flags | Purpose |
|---|---|---|
| `PLAN_ENC_KEY` | Masked, Protected | Passphrase for encrypting saved plans (generate with `openssl rand -base64 32`) |
| `AWS_ROLE_ARN` | Protected | Role assumed through OIDC (swap for your provider's equivalent) |

```yaml
# .gitlab-ci.yml
workflow:
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH
    - if: $CI_PIPELINE_SOURCE == "schedule"

stages:
  - validate
  - plan
  - apply
  - ops

variables:
  TF_ROOT: infra
  TF_STATE_NAME: production
  TF_ADDRESS: ${CI_API_V4_URL}/projects/${CI_PROJECT_ID}/terraform/state/${TF_STATE_NAME}

  # --- Terraform behavior in automation ---
  TF_IN_AUTOMATION: "true"
  TF_INPUT: "0"
  TF_PLUGIN_CACHE_DIR: ${CI_PROJECT_DIR}/.tf-plugin-cache

  # --- GitLab Managed State via the HTTP backend ---
  # SECURITY: CI_JOB_TOKEN is scoped to this job and expires when the job ends.
  # No long-lived state credential exists to leak or rotate.
  TF_HTTP_ADDRESS: ${TF_ADDRESS}
  TF_HTTP_LOCK_ADDRESS: ${TF_ADDRESS}/lock
  TF_HTTP_UNLOCK_ADDRESS: ${TF_ADDRESS}/lock
  TF_HTTP_LOCK_METHOD: POST
  TF_HTTP_UNLOCK_METHOD: DELETE
  TF_HTTP_USERNAME: gitlab-ci-token
  TF_HTTP_PASSWORD: ${CI_JOB_TOKEN}
  TF_HTTP_RETRY_WAIT_MIN: "5"

# ---------------------------------------------------------------------------
# Hidden base jobs
# ---------------------------------------------------------------------------
.tf:
  image:
    name: hashicorp/terraform:1.9.8   # pin exact versions; for OpenTofu use ghcr.io/opentofu/opentofu and `tofu`
    entrypoint: [""]
  before_script:
    - cd "${CI_PROJECT_DIR}/${TF_ROOT}"

# Jobs that touch cloud APIs: adds OIDC auth and tooling.
.tf_auth:
  extends: .tf
  id_tokens:
    # SECURITY: ambient OIDC. GitLab mints a short-lived JWT per job, signed by the
    # instance. The cloud IAM trust policy pins the `sub` claim to this project and
    # branch, so no static cloud keys are stored in CI variables.
    GITLAB_OIDC_TOKEN:
      aud: sts.amazonaws.com
  variables:
    AWS_WEB_IDENTITY_TOKEN_FILE: /tmp/gitlab_oidc_token
    AWS_ROLE_SESSION_NAME: gitlab-${CI_PIPELINE_ID}-${CI_JOB_ID}
  before_script:
    - apk add --no-cache jq openssl curl >/dev/null
    # SECURITY: restrictive umask, write token to a file the provider SDK reads
    # natively, never echo it, never enable `set -x` in this job.
    - umask 077
    - printf '%s' "${GITLAB_OIDC_TOKEN}" > "${AWS_WEB_IDENTITY_TOKEN_FILE}"
    # AWS_ROLE_ARN comes from a protected CI/CD variable. The AWS provider performs
    # AssumeRoleWithWebIdentity automatically when these two variables are present.
    - mkdir -p "${TF_PLUGIN_CACHE_DIR}"
    - cd "${CI_PROJECT_DIR}/${TF_ROOT}"
  cache:
    key:
      files:
        - ${TF_ROOT}/.terraform.lock.hcl
    paths:
      - .tf-plugin-cache/

# ---------------------------------------------------------------------------
# Stage: validate  (no cloud credentials, no state access)
# ---------------------------------------------------------------------------
fmt:
  extends: .tf
  stage: validate
  interruptible: true
  script:
    - terraform fmt -check -recursive -diff

validate:
  extends: .tf
  stage: validate
  interruptible: true
  script:
    # -backend=false: validation needs providers, not state or credentials.
    - terraform init -backend=false
    - terraform validate

tflint:
  stage: validate
  interruptible: true
  image:
    name: ghcr.io/terraform-linters/tflint:v0.53.0
    entrypoint: [""]
  script:
    - tflint --chdir="${TF_ROOT}" --init
    - tflint --chdir="${TF_ROOT}" --format=compact --minimum-failure-severity=warning

# ---------------------------------------------------------------------------
# Stage: plan
# ---------------------------------------------------------------------------
plan:
  extends: .tf_auth
  stage: plan
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH && $CI_PIPELINE_SOURCE == "push"
  script:
    - terraform init
    - |
      # MR plans are speculative and read-only: don't hold the state lock, so
      # reviewers never block a real apply. Main-branch plans take the lock.
      if [ "$CI_PIPELINE_SOURCE" = "merge_request_event" ]; then LOCK=false; else LOCK=true; fi
      terraform plan -lock=${LOCK} -lock-timeout=120s -out=tfplan
    # Summarize the diff for the job log and for metrics (section 4).
    - terraform show -json tfplan > plan.json
    - |
      ADD=$(jq '[.resource_changes[]? | select(.change.actions == ["create"])] | length' plan.json)
      CHG=$(jq '[.resource_changes[]? | select(.change.actions == ["update"])] | length' plan.json)
      DEL=$(jq '[.resource_changes[]? | select(.change.actions | index("delete"))] | length' plan.json)
      echo "Plan summary: add=${ADD} change=${CHG} destroy=${DEL}"
      printf 'tf_plan_resource_changes{action="add"} %s\ntf_plan_resource_changes{action="change"} %s\ntf_plan_resource_changes{action="destroy"} %s\n' \
        "$ADD" "$CHG" "$DEL" > "${CI_PROJECT_DIR}/plan.prom"
    # SECURITY: plan files embed resolved values, including secrets. GitLab artifacts
    # are not encrypted per-file, so encrypt before upload and delete plaintext.
    - openssl enc -aes-256-cbc -pbkdf2 -salt -in tfplan -out tfplan.enc -pass env:PLAN_ENC_KEY
    - rm -f tfplan plan.json
  artifacts:
    paths:
      - ${TF_ROOT}/tfplan.enc
      - plan.prom
    expire_in: 2 hours      # SECURITY: short-lived. A stale plan is also rejected by Terraform.
    access: developer       # SECURITY: only Developer+ can download; not public or Reporter-visible

# ---------------------------------------------------------------------------
# Stage: apply  (manual, default branch only, gated by protected environment)
# ---------------------------------------------------------------------------
apply:
  extends: .tf_auth
  stage: apply
  needs:
    - job: plan
      artifacts: true
  rules:
    # Only runs on the default branch after a merge. Branch protection (push
    # disallowed, MR approvals required) is what guarantees an approved MR.
    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH && $CI_PIPELINE_SOURCE == "push"
      when: manual
      allow_failure: false   # blocks the pipeline until a human acts
  environment:
    name: production         # configure as a Protected Environment with required approvers
  resource_group: terraform-production   # serialize applies across pipelines
  interruptible: false
  script:
    - terraform init
    - openssl enc -d -aes-256-cbc -pbkdf2 -in tfplan.enc -out tfplan -pass env:PLAN_ENC_KEY
    # Applying the saved plan means the exact diff a human reviewed is what executes.
    # If state drifted since plan, Terraform aborts with "Saved plan is stale".
    - terraform apply -lock-timeout=300s tfplan
    - rm -f tfplan
```

> **Note:** The plaintext-plan and OIDC-token cleanup for `apply` lives in the `.observability` template in section 4 (its `after_script` runs on success and failure). If you do not adopt that template, add this to the `apply` job:
>
> ```yaml
>   after_script:
>     - rm -f "${CI_PROJECT_DIR}/${TF_ROOT}/tfplan" /tmp/gitlab_oidc_token
> ```
>
> Do not define a job-level `after_script` *and* extend `.observability`. Job-level arrays replace inherited ones rather than merging, so one would silently discard the other.

### Wiring up the gates

The YAML alone does not enforce "apply only after MR approval." Configure these project settings:

1. **Settings → Repository → Protected branches:** Protect `main`. Set "Allowed to push" to No one and "Allowed to merge" to Maintainers.
2. **Settings → Merge requests → Merge request approvals:** Require at least one approval from Code Owners. Enable "Prevent approval by author" and "Remove all approvals when commits are added."
3. **Settings → CI/CD → Protected environments:** Add `production` and require approval from a named group. The manual `apply` button then needs a second human, even for someone who can merge.
4. **Settings → CI/CD → Variables:** Set `PLAN_ENC_KEY` and any provider secrets as **Protected** so they are exposed only to pipelines on protected refs. The trade-off is that MR pipelines can't see them. MR plans need read-only credentials, either through a second OIDC role scoped to MR refs or an unprotected read-only token.

### AWS trust policy (OIDC)

Scope the role to this project and branch. Without `sub` pinning, any project on your GitLab instance could assume it:

```json
{
  "Effect": "Allow",
  "Principal": { "Federated": "arn:aws:iam::<ACCOUNT_ID>:oidc-provider/gitlab.example.com" },
  "Action": "sts:AssumeRoleWithWebIdentity",
  "Condition": {
    "StringEquals": {
      "gitlab.example.com:aud": "sts.amazonaws.com",
      "gitlab.example.com:sub": "project_path:my-group/my-infra:ref_type:branch:ref:main"
    }
  }
}
```

Use separate roles for `plan` (read-only, MR refs allowed) and `apply` (write, `main` only). Not every provider supports OIDC. DigitalOcean and Vultr, for example, authenticate with API tokens. Store those as masked, protected variables scoped to the `production` environment, and rotate them on a schedule.

## 4. Extending Observability with Grafana, Prometheus, and Loki

Pipelines are your control plane, so treat them like a production service. Three signals matter:

- **Success rate** of `plan` and `apply` over time
- **Drift**, meaning real infrastructure diverging from state
- **Blast radius** of pending changes, especially destroys

### Metrics via Prometheus Pushgateway

Pipeline jobs are short-lived, so Prometheus can't scrape them. Push to a Pushgateway instead. Add this file and `include:` it from your main config. Then add `.observability` to the `extends` list of `plan` and `apply` (for example `extends: [.tf_auth, .observability]`).

```yaml
# ci/observability.gitlab-ci.yml
# Required CI/CD variables: PUSHGATEWAY_URL, PUSHGATEWAY_AUTH ("user:pass", masked),
#                           LOKI_URL, LOKI_AUTH ("user:pass", masked)
.observability:
  after_script:
    - apk add --no-cache curl >/dev/null 2>&1 || true
    - |
      # after_script runs even when the job failed; CI_JOB_STATUS is set here.
      OK=0; [ "${CI_JOB_STATUS}" = "success" ] && OK=1
      {
        cat plan.prom 2>/dev/null || true
        printf 'tf_job_success %s\n' "$OK"
        printf 'tf_job_last_run_timestamp_seconds %s\n' "$(date +%s)"
      } | curl -fsS --retry 3 -u "${PUSHGATEWAY_AUTH}" --data-binary @- \
        "${PUSHGATEWAY_URL}/metrics/job/terraform_ci/project/${CI_PROJECT_PATH_SLUG}/ci_job/${CI_JOB_NAME}"
    # Structured log line straight to Loki's push API (no agent needed on the runner).
    - |
      printf '{"streams":[{"stream":{"app":"terraform-ci","project":"%s","ci_job":"%s","status":"%s"},"values":[["%s000000000","pipeline=%s job=%s commit=%s"]]}]}' \
        "$CI_PROJECT_PATH_SLUG" "$CI_JOB_NAME" "$CI_JOB_STATUS" "$(date +%s)" \
        "$CI_PIPELINE_ID" "$CI_JOB_ID" "$CI_COMMIT_SHORT_SHA" \
      | curl -fsS -u "${LOKI_AUTH}" -H 'Content-Type: application/json' --data-binary @- \
        "${LOKI_URL}/loki/api/v1/push"
    # SECURITY: always remove the decrypted plan and the OIDC token file, even on failure.
    - rm -f "${CI_PROJECT_DIR}/${TF_ROOT}/tfplan" /tmp/gitlab_oidc_token
```

Two gotchas:

- **Grouping key must include the job name.** A Pushgateway `POST` replaces all metrics with the same *name* inside a group, across label sets. If `plan` and `apply` shared a group, each push would erase the other's `tf_job_success`. The `ci_job` path segment above prevents that.
- **Pushgateway holds the last value forever.** A silently dead pipeline looks healthy. This is why the staleness alert below matters.

### Drift detection job

`terraform plan -detailed-exitcode` returns 0 for no changes, 1 for error, and 2 when changes are pending. On a schedule with nothing merged, exit code 2 means someone changed infrastructure out-of-band. Create a pipeline schedule (Build → Pipeline schedules) with variable `SCHEDULE_TYPE=drift`.

```yaml
# Add to .gitlab-ci.yml
drift:
  extends: [.tf_auth, .observability]
  stage: ops
  rules:
    - if: $CI_PIPELINE_SOURCE == "schedule" && $SCHEDULE_TYPE == "drift"
  script:
    - terraform init
    - rc=0
    # -lock=false: drift checks are read-only and must never block a real apply.
    - terraform plan -detailed-exitcode -lock=false -lock-timeout=60s -out=/dev/null || rc=$?
    - printf 'tf_drift_detected %s\n' "$([ "$rc" -eq 2 ] && echo 1 || echo 0)" > "${CI_PROJECT_DIR}/plan.prom"
    - |
      if [ "$rc" -eq 1 ]; then echo "plan errored"; exit 1; fi
      if [ "$rc" -eq 2 ]; then echo "DRIFT DETECTED: state and infrastructure disagree"; fi
```

The job succeeds on drift by design, so the pipeline stays green and the signal travels through `tf_drift_detected`. Alert on the metric rather than on job failure, so real errors (exit 1) stay distinguishable from drift.

### Prometheus alert rules

```yaml
# prometheus/rules/terraform-ci.yml
groups:
  - name: terraform-ci
    rules:
      - alert: TerraformDriftDetected
        expr: tf_drift_detected{project="my-group-my-infra"} == 1
        for: 5m
        labels: { severity: warning }
        annotations:
          summary: "Drift detected in {{ $labels.project }}"

      - alert: TerraformApplyFailed
        expr: tf_job_success{ci_job="apply"} == 0
        labels: { severity: critical }
        annotations:
          summary: "Last terraform apply failed in {{ $labels.project }}"

      - alert: TerraformDriftCheckStale
        expr: time() - tf_job_last_run_timestamp_seconds{ci_job="drift"} > 2 * 86400
        labels: { severity: warning }
        annotations:
          summary: "Drift check has not reported in 48h. The scheduler or runner may be dead."

      - alert: TerraformPlanContainsDestroys
        expr: tf_plan_resource_changes{action="destroy", ci_job="plan"} > 0
        labels: { severity: info }
        annotations:
          summary: "Pending plan destroys {{ $value }} resources. Review before approving."
```

### Loki: success rate and failure forensics

Pushgateway only stores the latest value. Loki stores every run, so use it for historical rates. These LogQL queries work as Grafana panels:

```logql
# 30-day apply success rate (single-stat panel)
sum(count_over_time({app="terraform-ci", ci_job="apply", status="success"}[30d]))
/
sum(count_over_time({app="terraform-ci", ci_job="apply"}[30d]))

# Failed runs, newest first (logs panel)
{app="terraform-ci", status="failed"} | logfmt

# Applies per day (bar chart)
sum by (project) (count_over_time({app="terraform-ci", ci_job="apply"}[1d]))
```

For runner-host logs such as executor crashes, OOM kills, and registration errors, tail the service with Grafana Alloy. Job output itself lives in GitLab, so these logs cover runner lifecycle, not Terraform output.

```alloy
loki.source.journal "gitlab_runner" {
  matches    = "_SYSTEMD_UNIT=gitlab-runner.service"
  labels     = { app = "gitlab-runner", host = constants.hostname }
  forward_to = [loki.write.default.receiver]
}

loki.write "default" {
  endpoint {
    url = "https://loki.example.com/loki/api/v1/push"
  }
}
```

If you also want pipeline duration, queue time, and per-ref status without custom code, run [`gitlab-ci-pipelines-exporter`](https://github.com/mvisonneau/gitlab-ci-pipelines-exporter). It scrapes the GitLab API and exposes Prometheus metrics natively. It complements the push-based approach above: the exporter covers pipeline mechanics, and the pushed metrics cover Terraform semantics.

### Suggested dashboard layout

| Row | Panel | Source |
|---|---|---|
| 1 | Drift status (stat, red at 1), time since last drift check | `tf_drift_detected`, staleness expr |
| 2 | Apply success rate 30d, applies per day | Loki |
| 3 | Pending add/change/destroy per project | `tf_plan_resource_changes` |
| 4 | Failed-run log stream | Loki `status="failed"` |

## 5. Infrastructure Placement & Production Recommendations

*Disclosure: provider links in this section are affiliate links. We earn a commission if you sign up, at no cost to you. Evaluate against your own requirements and verify current pricing yourself.*

This architecture has two infrastructure footprints: the **runner fleet** that executes Terraform and the **object storage** for caches and state backups. Neither needs a hyperscaler's premium tier. Hyperscaler pricing buys you IAM depth, compliance certifications, and a large service catalog. A CI runner host uses none of that.

### Runner hosts

For a small-to-mid team, a single Docker-executor runner on a general-purpose VM is enough: 2 vCPU and 4 GB RAM handles typical `plan`/`apply` concurrency of 2–4 jobs. The memory-hungry part is large provider binaries (AWS, Azure) loading in parallel, not CPU.

- **[DigitalOcean]({{AFFILIATE_URL_DIGITALOCEAN}}) Droplets:** Predictable flat pricing and simple networking. Use a Droplet for the Docker executor. If you want ephemeral per-job pods, [DigitalOcean Kubernetes (DOKS)]({{AFFILIATE_URL_DIGITALOCEAN}}) pairs with GitLab's Kubernetes executor. Verify current control-plane pricing, since the standard control plane has historically been free.
- **[Vultr]({https://www.vultr.com/?ref=9935169}}):** A comparable option with a wide region footprint, which helps if you want runners geographically close to the APIs you provision. Vultr Kubernetes Engine https://www.vultr.com/?ref=9935169 fills the same role as DOKS.

Both have first-party Terraform providers, so the runner infrastructure can be bootstrapped by this same pipeline once the first runner exists.

### Object storage

GitLab Managed State covers your state. Object storage covers everything adjacent to it:

1. **Runner cache:** Provider plugins are hundreds of MB. A shared S3-compatible cache avoids re-downloading them on every job across a multi-runner fleet.
2. **State backups:** Managed state is versioned, but a defense-in-depth copy in an independent system is cheap insurance against a GitLab-side incident or an accidental project deletion.
3. **Plan archives and audit artifacts:** Longer retention than the 2-hour CI artifact window, if compliance requires it.

[DigitalOcean Spaces]({{AFFILIATE_URL_DIGITALOCEAN}}), [Vultr Object Storage]({{AFFILIATE_URL_VULTR}}), and [AWS S3]({{AFFILIATE_URL_AWS}}) all speak the S3 API. Choose AWS S3 if your workloads already live there and you want IAM-native access control and Object Lock. Choose Spaces or Vultr if you want simpler billing and the lowest cost for non-enterprise workloads. Compare egress terms before committing, because that is where object-storage cost surprises usually come from.

**Runner cache configuration** (`/etc/gitlab-runner/config.toml`, DigitalOcean Spaces example):

```toml
concurrent = 4

[[runners]]
  name = "tf-runner-01"
  url = "https://gitlab.example.com"
  executor = "docker"
  [runners.docker]
    image = "alpine:3.20"
    privileged = false
    volumes = ["/cache"]
  [runners.cache]
    Type = "s3"
    Shared = true
    [runners.cache.s3]
      ServerAddress = "nyc3.digitaloceanspaces.com"
      BucketName    = "ci-runner-cache"
      BucketLocation = "nyc3"
      AccessKey     = "<SPACES_ACCESS_KEY>"
      SecretKey     = "<SPACES_SECRET_KEY>"
      Insecure      = false
```

For Vultr Object Storage, change `ServerAddress` and `BucketLocation` to your Vultr region endpoint. For AWS S3, drop `ServerAddress` and set only the region.

**Scheduled state backup job** (create a schedule with `SCHEDULE_TYPE=backup`):

```yaml
state-backup:
  stage: ops
  image: alpine:3.20
  rules:
    - if: $CI_PIPELINE_SOURCE == "schedule" && $SCHEDULE_TYPE == "backup"
  variables:
    AWS_ACCESS_KEY_ID: ${BACKUP_S3_KEY}
    AWS_SECRET_ACCESS_KEY: ${BACKUP_S3_SECRET}
    AWS_DEFAULT_REGION: us-east-1
    # Recent AWS CLI versions send integrity checksums that some S3-compatible
    # providers reject. Restore the pre-2025 behavior for portability.
    AWS_REQUEST_CHECKSUM_CALCULATION: when_required
    AWS_RESPONSE_CHECKSUM_VALIDATION: when_required
  script:
    - apk add --no-cache curl aws-cli >/dev/null
    - curl -fsS --user "gitlab-ci-token:${CI_JOB_TOKEN}" -o state.json "${TF_ADDRESS}"
    - |
      aws s3 cp state.json \
        "s3://${BACKUP_BUCKET}/${CI_PROJECT_PATH}/${TF_STATE_NAME}/$(date -u +%Y%m%dT%H%M%SZ).tfstate" \
        --endpoint-url "${BACKUP_S3_ENDPOINT}"
  after_script:
    - rm -f state.json
```

State files contain secrets in plaintext. Enable bucket-level encryption where the provider supports it, restrict the backup credential to `PutObject` only, and apply a lifecycle policy so versions expire on a schedule you can defend in an audit.

### Production recommendations

1. **Isolate the runner.** Run it in its own VPC or project with no inbound access. It needs outbound HTTPS to GitLab, your cloud APIs, and your Pushgateway/Loki, and nothing else.
2. **Never use `privileged = true`** for a Terraform runner. Nothing in this pipeline needs Docker-in-Docker.
3. **Tag and dedicate runners.** Add `tags: [terraform]` to your jobs and register the runner with the matching tag, so application CI jobs can't land on a host that holds infrastructure credentials.
4. **Split state by blast radius.** One state per environment (`TF_STATE_NAME: staging` / `production`) at minimum. Large monoliths should split further by layer (network, data, compute), since lock contention and plan time both grow with state size.
5. **Treat the break-glass path as part of the design.** Document who can `force-unlock`, who can apply locally with a state download, and how that access is audited. Your first stuck lock will not happen at a convenient time.
6. **Pin everything:** Terraform/OpenTofu version, provider versions in `.terraform.lock.hcl`, tflint version, and runner image tags. An unpinned `latest` in an infrastructure pipeline is an incident waiting for a schedule.

Cost is the headline reason to leave a managed platform, but ownership is the actual trade. You gain control, auditability, and predictable pricing. You take on runner patching, backup verification, and on-call for your own pipeline. For teams that already operate GitLab, that is a small increment, and the observability layer above is what keeps it manageable.