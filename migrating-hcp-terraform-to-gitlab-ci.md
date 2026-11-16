---
title: Migrate HCP Terraform State to GitLab CI
description: Step-by-step migration of HCP Terraform (Terraform Cloud) state, workspaces, and variables to GitLab-managed state, with verification and a rollback plan.
---

# Migrating from HCP Terraform to GitLab CI Without Downtime

> **Affiliate disclosure:** We earn commissions when you shop through the links below. The DigitalOcean and Vultr links marked “affiliate” in Section 5 are referral links; if you sign up through them, we may earn a commission at no additional cost to you. Our technical opinions remain our own.

Leaving HCP Terraform (formerly Terraform Cloud) is mostly a change of address for your state file. The resources it describes don't move, and nothing in this guide runs `apply` against them. What changes is where state lives, who can start a run, and where variables and credentials come from. Sequenced properly, the only interruption is a short freeze on applies, and the state is never writable in two places at once.

This guide covers the migration itself: inventory, state transfer, verification, environment mapping, and rollback. For the target pipeline (stages, OIDC, drift detection, observability), see the [architecture guide](/terraform-cloud-alternative-gitlab-ci). The commands use `terraform`; with OpenTofu, substitute `tofu`.

::: warning Run it on staging first
Migrate your least critical workspace end to end and keep the others locked until it passes verification. Everything below changes where state lives. None of it should change a resource. If a plan shows changes after migration, stop and find out why before you apply anything.
:::

## 1. What Moves and What "No Downtime" Means

| HCP Terraform | GitLab destination | Where it is covered |
|---|---|---|
| Workspace state | One GitLab-managed state per workspace | Section 3 |
| Workspace as an environment | `TF_STATE_NAME` plus a protected environment | Section 4 |
| Non-sensitive Terraform variables | `env/<name>.tfvars` in git | Section 2.3 |
| Sensitive variables | Masked, protected CI/CD variables (`TF_VAR_*`) or a secrets manager | Section 2.4 |
| Cloud credentials in environment variables | OIDC, with no stored keys | [Architecture guide](/terraform-cloud-alternative-gitlab-ci) |
| VCS-driven runs and run triggers | Merge request and default-branch pipelines | Section 3, Step 5 |
| Private registry modules | Keep them with a token, or move to GitLab's module registry or git sources | Section 2.6 |
| Sentinel, run tasks, cost estimates | OPA/Conftest, Checkov, and Infracost as CI jobs | [Architecture guide](/terraform-cloud-alternative-gitlab-ci) |
| Health assessments (drift) | Scheduled `plan -detailed-exitcode` job | [Architecture guide](/terraform-cloud-alternative-gitlab-ci) |

For your infrastructure, nothing is interrupted. Terraform reads and writes state, not resources. What you do interrupt is the change pipeline: while a workspace is locked, new runs wait, and applies resume from GitLab once verification passes. Plan the freeze like any other change window and tell the teams who merge to these repositories.

## 2. Pre-Migration Checklist & Risk Assessment

### 2.1 Risks and controls

| Risk | How it fails | Control |
|---|---|---|
| Forked state | Something still runs the `cloud` configuration after cutover and writes to HCP, so two histories diverge. | Lock every migrated HCP workspace and leave it locked. Remove `cloud` blocks and HCP tokens from every repository, laptop, and pipeline that touched it. |
| Wrong Terraform version | CI runs a different release than the workspace did, and a release you didn't plan to adopt rewrites the state. | Match the workspace's Terraform version in the CI image. Upgrade in a separate change. |
| Provider drift | Unpinned providers resolve to newer releases and produce a diff unrelated to the migration. | Commit `.terraform.lock.hcl` with hashes for the runner platform. |
| Missing inputs | Sensitive variables, `TFC_*` run variables, or `terraform.workspace` values that existed in HCP are absent in CI. | Inventory first (2.3), scan the code (2.6), and treat any non-empty plan as an input problem. |
| Lost or damaged state | A failed copy or a mistaken overwrite. | Pull and checksum every state before you touch a backend (Step 1). Keep the HCP workspace intact. |
| Credential exposure | State files and tokens land on disk, in shell history, or in git. | `umask 077`, keep `migration/` out of git, pass the token through the environment, never through `-backend-config`. |
| Broken cross-workspace reads | Other configurations read outputs from HCP with `terraform_remote_state`. | Update the consumers (4.4). |

### 2.2 Freeze the workspaces

Lock each workspace you are migrating (Actions menu, or Settings → Locking). [HashiCorp's documentation](https://developer.hashicorp.com/terraform/cloud-docs/workspaces/run/manage) says new runs then stay Pending until the workspace unlocks, while plan-only runs and the planning stage of saved-plan runs are not blocked. You can't lock a workspace while a run is in progress, so let the run finish or cancel it first.

A lock only stops HCP's own run queue. Also look for anything that talks to the workspace from outside: CI jobs with a `cloud` block, scheduled scripts, and run triggers from other workspaces.

### 2.3 Inventory the variables

Export the variable metadata for every workspace. The script prints one row per variable (category, whether it is sensitive, whether it is HCL, and the key) and never prints a value.

```bash
umask 077
: "${TFE_HOST:=app.terraform.io}"
: "${TFE_ORG:?set your HCP Terraform organization name}"
: "${WORKSPACES:?set a space-separated list of workspace names}"
if [ -z "${TFE_TOKEN:-}" ]; then read -rs -p "HCP Terraform API token: " TFE_TOKEN; echo; fi

api() {
  curl -fsS \
    -H "Authorization: Bearer ${TFE_TOKEN}" \
    -H "Content-Type: application/vnd.api+json" \
    "https://${TFE_HOST}/api/v2/$1"
}

mkdir -p migration/inventory
for ws in ${WORKSPACES}; do
  ws_id="$(api "organizations/${TFE_ORG}/workspaces/${ws}" | jq -r .data.id)"
  api "workspaces/${ws_id}/vars" > "migration/inventory/${ws}.vars.json"
  echo "== ${ws} (${ws_id})"
  jq -r '.data[].attributes
         | [.category,
            (if .sensitive then "SENSITIVE" else "plain" end),
            (if .hcl then "hcl" else "string" end),
            .key]
         | @tsv' "migration/inventory/${ws}.vars.json" | sort
done
```

Non-sensitive Terraform variables belong in git, where a merge request can review them. This turns each workspace's `plain` variables in the `terraform` category into a `.tfvars` file. It escapes `${` and `%{` so values containing them aren't interpreted as HCL templates.

```bash
mkdir -p infra/env
for ws in ${WORKSPACES}; do
  jq -r '.data[].attributes
         | select(.category == "terraform" and (.sensitive | not))
         | if .hcl
           then "\(.key) = \(.value)"
           else "\(.key) = \(.value | @json | gsub("\\$\\{"; "$${") | gsub("%\\{"; "%%{"))"
           end' "migration/inventory/${ws}.vars.json" > "infra/env/${ws}.tfvars"
done
```

Review each file before you commit it. Non-sensitive environment variables (category `env`) go in the `variables:` block of the CI file. Add `migration/` to `.gitignore` now, because the inventory files hold variable values:

```bash
printf 'migration/\n' >> .gitignore
```

### 2.4 Secrets

HCP's API documents a sensitive variable as ["written once and not visible thereafter"](https://developer.hashicorp.com/terraform/cloud-docs/api-docs/workspace-variables). There is no export. For each `SENSITIVE` row, recover the value from wherever it came from: a password manager, a cloud secret store, the person who created it. If nobody can, rotate it.

Where the values go in GitLab:

- **Terraform variables:** `TF_VAR_<name>` CI/CD variables, marked **Protected**. Protected variables are only available to pipelines on protected branches and tags, so merge request pipelines won't see them.
- **Masking:** [GitLab](https://docs.gitlab.com/ci/variables) masks only values that are a single line with no spaces and at least 8 characters, and, while variable expansion is on, limits the allowed characters. Turning expansion off lifts the character limit. Multi-line material such as certificates doesn't fit; use a file-type variable or a secrets manager, and never print it.
- **Per-environment values:** Environment scope is documented as a Premium and Ultimate feature. On Free, use one variable name per environment and map it in the job, as Section 4 does.
- **Static cloud keys** (`AWS_ACCESS_KEY_ID` and similar): don't migrate them. Replace them with OIDC, using the trust policy in the [architecture guide](/terraform-cloud-alternative-gitlab-ci).

### 2.5 Versions and providers

For each workspace, note the Terraform version under Settings → General, and pin the CI image to that exact release. Terraform won't read state written by a newer release, so an older CI image fails early, which is the safe direction. A newer image does the opposite: it writes its own version into the state, and older releases (including the one your HCP workspace is pinned to) can no longer read it, which complicates rollback. Upgrade as a separate change after the migration is stable.

Lock provider hashes for the platforms that will run Terraform:

```bash
terraform providers lock -platform=linux_amd64 -platform=darwin_arm64
git add .terraform.lock.hcl
```

Add your own workstation platform if it isn't in that list.

### 2.6 Scan the code for HCP-only assumptions

```bash
grep -rnE 'terraform\.workspace|TFC_|TFE_|app\.terraform\.io|backend[[:space:]]*=[[:space:]]*"remote"|cloud[[:space:]]*\{' \
  --include='*.tf' --include='*.yml' --include='*.yaml' --include='*.sh' .
```

- **`terraform.workspace`:** HashiCorp staff [note](https://discuss.hashicorp.com/t/terraform-cloud-to-local-state/34138) that after migration it returns `default` instead of the HCP workspace name. If it feeds a resource name or tag, the plan will want to replace that resource. Replace it with an explicit variable set to the old value, apply that no-op change in HCP, and only then migrate.
- **`TFC_*` and `TFE_*`:** These run variables exist only inside HCP runs. Replace them with ordinary variables.
- **`app.terraform.io` module sources:** Private registry modules still need credentials in CI. Terraform reads them from a `TF_TOKEN_app_terraform_io` environment variable (dots in the hostname become underscores). Store it as a masked, protected variable with a read-only token, or republish the modules to git or GitLab's module registry.
- **`backend = "remote"` or `cloud` blocks in other repositories:** These are consumers of the workspaces you are moving. See 4.4.

## 3. Step-by-Step State Migration

Do one workspace completely before starting the next. Run these steps from a workstation that can reach HCP Terraform, GitLab, and your cloud API with read-only access. Start in the repository root, and run Steps 1 to 4 from the Terraform root, `infra/`. Every path to the backups is absolute, so the working directory can't break it.

### Step 0: Set up the shell

```bash
: "${GITLAB_API:=https://gitlab.com/api/v4}"
: "${GITLAB_PROJECT_ID:?set from Settings → General → Project ID}"
: "${TF_HTTP_USERNAME:?set to your GitLab username}"
if [ -z "${TF_HTTP_PASSWORD:-}" ]; then
  read -rs -p "GitLab token (api scope, Maintainer role): " TF_HTTP_PASSWORD; echo
fi
export GITLAB_API GITLAB_PROJECT_ID TF_HTTP_USERNAME TF_HTTP_PASSWORD
export TF_HTTP_LOCK_METHOD=POST TF_HTTP_UNLOCK_METHOD=DELETE TF_HTTP_RETRY_WAIT_MIN=5
unset TF_WORKSPACE

REPO_ROOT="$(pwd)"                      # run Step 0 from the repository root
BACKUPS="${REPO_ROOT}/migration/backups"
export REPO_ROOT BACKUPS
```

[GitLab's documentation](https://docs.gitlab.com/ee/user/infrastructure/iac/terraform_state.html) requires the Maintainer role to write and lock state; Developer can read it. Use a short-lived token and revoke it when you finish.

::: warning Keep the token out of `-backend-config`
Values passed with `-backend-config` are written in plaintext to `.terraform/terraform.tfstate`. The `TF_HTTP_*` environment variables are not persisted. Pass credentials only through the environment.
:::

`unset TF_WORKSPACE` matters: with the HTTP backend, a set `TF_WORKSPACE` makes state loading fail with "workspaces not supported".

### Step 1: Pull and fingerprint every state

Run this from `infra/`, with the `cloud` block still in place and the workspaces locked:

```bash
umask 077
mkdir -p "${BACKUPS}"
cd "${REPO_ROOT}/infra"
terraform init
for ws in ${WORKSPACES}; do
  terraform workspace select "${ws}"
  terraform state pull > "${BACKUPS}/${ws}.tfstate"
  terraform state list | sort > "${BACKUPS}/${ws}.resources.txt"
  jq -r --arg ws "${ws}" \
    '"\($ws): Terraform \(.terraform_version), serial \(.serial), \(.resources | length) resource blocks"' \
    "${BACKUPS}/${ws}.tfstate"
done
( cd "${BACKUPS}" && sha256sum ./*.tfstate > SHA256SUMS )
```

If your `cloud` block names a single workspace instead of using tags, there is nothing to select; drop the `workspace select` line.

`state pull` is read-only. The pulled files plus the untouched HCP workspaces are your rollback. They contain secrets in plaintext, so treat them accordingly (see Section 5.3).

### Step 2: Point the code at the HTTP backend

On a branch, delete the `cloud` block and set:

```hcl
# infra/backend.tf
terraform {
  backend "http" {}
}
```

The block stays empty on purpose. Address, lock endpoints, and credentials all come from `TF_HTTP_*`, so the same code runs locally and in CI.

### Step 3: Migrate one state

Still in `infra/`:

```bash
ws=staging
export TF_HTTP_ADDRESS="${GITLAB_API}/projects/${GITLAB_PROJECT_ID}/terraform/state/${ws}"
export TF_HTTP_LOCK_ADDRESS="${TF_HTTP_ADDRESS}/lock"
export TF_HTTP_UNLOCK_ADDRESS="${TF_HTTP_ADDRESS}/lock"

rm -rf .terraform terraform.tfstate
cp "${BACKUPS}/${ws}.tfstate" terraform.tfstate
terraform init -migrate-state
```

Terraform finds the local `terraform.tfstate` and no state in the new backend, then asks whether to copy it. Read the prompt and answer `yes`. It takes the GitLab lock, writes the state, and releases the lock.

Two details explain why the sequence looks roundabout:

- **Why a local file?** The `cloud` backend is a poor source for a migration to another backend, and users report errors such as "Migrating state from Terraform Cloud to another backend is not yet implemented". [HashiCorp's guidance](https://discuss.hashicorp.com/t/terraform-cloud-to-local-state/34138) is to pull the state first. That also gives you the backup from Step 1 for free.
- **Why `rm -rf .terraform`?** It discards the cached `cloud` backend settings so Terraform treats this as a fresh initialization with an existing local state.

Once the first migration is trusted, `terraform init -migrate-state -force-copy -input=false` answers the prompt for you. An alternative that suits scripts is `terraform init` followed by `terraform state push "${BACKUPS}/${ws}.tfstate"`. Both end in the same place: the same resources in GitLab. In my OpenTofu 1.8.5 test against a mock state API, the GitLab copy came out with a different lineage ID than the pulled file, but I haven't verified that against a real HCP workspace or the Terraform binary. Don't use lineage or serial as the check; use the resource list and a clean plan below.

Remove the local copy when you finish: `rm -f terraform.tfstate terraform.tfstate.backup`.

### Step 4: Verify

Run this from `infra/`, with the same variables the HCP workspace had and a read-only cloud profile:

```bash
# 1. The same resources are in state.
terraform state list | sort | diff - "${BACKUPS}/${ws}.resources.txt" \
  && echo "resource list identical"

# 2. Nothing is pending.
terraform plan -detailed-exitcode -input=false -var-file="env/${ws}.tfvars"
echo "exit=$?"
```

| Exit code | Meaning | What to do |
|---|---|---|
| `0` | State and configuration agree. | Continue. |
| `2` | Terraform wants changes. | Stop. Missing sensitive variables, a different Terraform or provider version, and `terraform.workspace` usage are the usual causes. Don't apply. |
| `1` | An error. | Fix it and rerun. |

Then check that locking works. Do this on staging only, because it briefly locks the state:

```bash
curl -fsS -u "${TF_HTTP_USERNAME}:${TF_HTTP_PASSWORD}" -X POST \
  -H "Content-Type: application/json" \
  -d '{"ID":"migration-test","Operation":"manual","Who":"migration"}' \
  "${TF_HTTP_LOCK_ADDRESS}"

terraform plan -lock-timeout=5s -input=false    # expect: Error acquiring the state lock

curl -fsS -u "${TF_HTTP_USERNAME}:${TF_HTTP_PASSWORD}" -X DELETE "${TF_HTTP_UNLOCK_ADDRESS}"
```

The error names the holder's lock ID (`migration-test`). Finally, open Operate → Terraform states in GitLab and confirm the state and its first version are listed.

### Step 5: Cut over

1. Merge the backend change. The default-branch pipeline's `plan` job is your first proof under real conditions: OIDC credentials, the job token, and `resource_group`. It should report no changes.
2. In HCP, disconnect the VCS connection, remove run triggers and notifications, and leave the workspace locked with a reason such as "Migrated to GitLab. Do not unlock." Don't delete it yet.
3. Revoke the HCP API tokens that CI and individuals used, and the GitLab token you used for the migration.
4. Move the `migration/backups/` directory into encrypted storage with a retention date (Section 5.3), then delete the local copies.
5. Update runbooks, and fix any `terraform_remote_state` consumers (4.4).

### Rollback

Before the first GitLab `apply`, HCP still holds the current state. Unlock the HCP workspace, revert the backend commit, run `rm -rf .terraform`, and `terraform init` against the `cloud` block again. Nothing needs to be pushed, because HCP's state was never changed.

After GitLab has applied anything, the HCP copy is stale. Pull the current state from GitLab, restore the `cloud` block, unlock the workspace, and push the pulled file with `terraform state push`. Try it without `-force` first. `state push` can refuse to overwrite a state whose lineage differs (OpenTofu 1.8.5 did in my mock-API test; I haven't confirmed how Terraform or a real HCP workspace behaves). Treat that refusal as a prompt to check, and add `-force` only after the comparison below. Compare the serial and resource list of both copies before forcing, because `-force` overwrites whatever HCP holds. Keep the HCP workspace for a defined window (30 to 90 days is common) before you delete it.

## 4. Workspace-to-GitLab Environment Mapping

An HCP workspace bundles a state, a variable set, a run queue, a permission boundary, and an execution environment. GitLab separates them. That's more to configure, and each piece is easier to review.

| HCP workspace setting | GitLab equivalent |
|---|---|
| Workspace name | `TF_STATE_NAME`, which becomes the state's name in the URL |
| Terraform variables | `env/<name>.tfvars` plus `TF_VAR_*` for secrets |
| Environment variables | `variables:` in the CI file, or masked CI/CD variables |
| Working directory | `TF_ROOT` |
| Terraform version | CI image tag |
| Run queue | `resource_group`, one per environment |
| Auto-apply off | A `when: manual` apply job |
| Workspace permissions | Protected environments (Premium/Ultimate), plus project roles |

### 4.1 Repository layout

```text
infra/
├── backend.tf              # backend "http" {}
├── main.tf
├── .terraform.lock.hcl     # committed
└── env/
    ├── staging.tfvars      # generated in 2.3, reviewed
    └── production.tfvars
```

### 4.2 One pipeline, one state per environment

The HTTP backend has no workspaces; `terraform workspace new` fails with "workspaces not supported". The model is one named state per environment instead. Because the global `TF_ADDRESS` and `TF_HTTP_*` variables in the [architecture guide's pipeline](/terraform-cloud-alternative-gitlab-ci) are built from `TF_STATE_NAME`, setting that one variable per job points the same backend block at a different state.

This replaces the single `plan` and `apply` jobs from that guide. It reuses its `.tf_auth` template:

```yaml
.staging:
  variables:
    TF_STATE_NAME: staging
    TF_CLI_ARGS_plan: "-var-file=env/staging.tfvars"
    TF_VAR_db_password: $STAGING_DB_PASSWORD        # protected, masked CI/CD variable

.production:
  variables:
    TF_STATE_NAME: production
    TF_CLI_ARGS_plan: "-var-file=env/production.tfvars"
    TF_VAR_db_password: $PRODUCTION_DB_PASSWORD     # protected, masked CI/CD variable

.plan:
  extends: .tf_auth
  stage: plan
  rules:
    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH && $CI_PIPELINE_SOURCE == "push"
  script:
    - terraform init
    - terraform plan -lock-timeout=120s -out=tfplan
    # SECURITY: saved plans embed resolved values. Encrypt before upload.
    - openssl enc -aes-256-cbc -pbkdf2 -salt -in tfplan -out tfplan.enc -pass env:PLAN_ENC_KEY
    - rm -f tfplan
  artifacts:
    paths:
      - ${TF_ROOT}/tfplan.enc
    expire_in: 2 hours
    access: developer

.apply:
  extends: .tf_auth
  stage: apply
  rules:
    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH && $CI_PIPELINE_SOURCE == "push"
      when: manual
      allow_failure: false
  interruptible: false
  script:
    - terraform init
    - openssl enc -d -aes-256-cbc -pbkdf2 -in tfplan.enc -out tfplan -pass env:PLAN_ENC_KEY
    - terraform apply -lock-timeout=300s tfplan
  # If you also extend .observability, delete this after_script: it already
  # removes the plaintext plan and the OIDC token, and a job-level after_script
  # would replace the inherited one.
  after_script:
    - rm -f "${CI_PROJECT_DIR}/${TF_ROOT}/tfplan" "${AWS_WEB_IDENTITY_TOKEN_FILE}"

plan:staging:
  extends: [.plan, .staging]
  variables:
    AWS_ROLE_ARN: $AWS_ROLE_ARN_PLAN_STAGING

apply:staging:
  extends: [.apply, .staging]
  needs:
    - job: plan:staging
      artifacts: true
  environment:
    name: staging
  resource_group: terraform-staging
  variables:
    AWS_ROLE_ARN: $AWS_ROLE_ARN_APPLY_STAGING

plan:production:
  extends: [.plan, .production]
  variables:
    AWS_ROLE_ARN: $AWS_ROLE_ARN_PLAN_PRODUCTION

apply:production:
  extends: [.apply, .production]
  needs:
    - job: plan:production
      artifacts: true
    - job: apply:staging          # promotion: production waits for a clean staging apply
  environment:
    name: production
  resource_group: terraform-production
  variables:
    AWS_ROLE_ARN: $AWS_ROLE_ARN_APPLY_PRODUCTION
```

Why it is built this way:

- **`TF_CLI_ARGS_plan`** adds the var-file to `plan` only. A saved plan already contains its inputs, and `apply` with a plan file takes no variable arguments.
- **`resource_group` per environment** serializes applies within an environment while staging and production can still run side by side. The state lock remains the backstop.
- **`needs: apply:staging`** is the promotion gate. A production apply can't start until staging has applied successfully.
- **One variable name per environment** (`STAGING_DB_PASSWORD`, `PRODUCTION_DB_PASSWORD`) gives you per-environment secrets on any tier without environment scope.

### 4.3 Access control

[Protected environments](https://docs.gitlab.com/ci/environments/protected_environments) are a Premium and Ultimate feature. With them, you can restrict who deploys to `production` and require approvals. On Free, the practical control is branch protection: protect the default branch, restrict who can merge to it, and keep apply as a manual job. Check your tier's approval options before you promise reviewers a gate that doesn't exist.

Roles matter independently of that. Writing and locking state requires Maintainer, and reading requires Developer, so whoever plays the apply job needs Maintainer, while reviewers who only read plans need Developer.

### 4.4 Cross-workspace references

Configurations that read another workspace's outputs through `terraform_remote_state` need a new backend configuration. Keeping the producer and the consumer in the same GitLab project avoids most of the access questions:

```hcl
variable "network_state_address" {
  type        = string
  description = "GitLab state URL ending in /terraform/state/network"
}

variable "gitlab_state_user" {
  type    = string
  default = "gitlab-ci-token"
}

variable "gitlab_state_password" {
  type      = string
  sensitive = true
}

data "terraform_remote_state" "network" {
  backend = "http"

  config = {
    address  = var.network_state_address
    username = var.gitlab_state_user
    password = var.gitlab_state_password
  }
}
```

In CI, set `TF_VAR_gitlab_state_password: $CI_JOB_TOKEN` and `TF_VAR_network_state_address: ${CI_API_V4_URL}/projects/${NETWORK_PROJECT_ID}/terraform/state/network`, with `NETWORK_PROJECT_ID` defined as a CI/CD variable. Reading another project's state needs at least Developer there, and its CI/CD job token settings must allow your project.

## 5. Infrastructure Placement & Runner Sizing

*Affiliate disclosure: DigitalOcean and Vultr links marked “affiliate” below are referral links; if you sign up through them, we may earn a commission at no extra cost to you. AWS links are direct. Verify current pricing and terms yourself.*

The migration itself needs no new infrastructure. Run it from a workstation that can reach HCP Terraform, GitLab, and your cloud's API. The infrastructure decisions start after cutover, when the pipeline needs somewhere to run and the state needs a copy outside GitLab. The [architecture guide](/terraform-cloud-alternative-gitlab-ci) covers the full runner design. This section covers sizing it for the estate you just migrated.

### 5.1 Size the runner from a measurement

Terraform's memory use is dominated by provider binaries and the size of the resource graph, so measure it. On a Linux workstation with GNU `time`, run the plan you used for verification:

```bash
/usr/bin/time -v terraform plan -input=false -lock=false -var-file="env/production.tfvars" 2>&1 >/dev/null \
  | grep -E 'Maximum resident set size|Elapsed'
```

A workable planning heuristic is runner RAM ≈ concurrent jobs × peak resident memory × 1.5, plus about 1 GB for the operating system and Docker. Treat it as a starting estimate and confirm it under real load.

| Estate | Starting point | Notes |
|---|---|---|
| One or two environments, a few hundred resources | 2 vCPU / 4 GB, `concurrent = 2` | The baseline used in the architecture guide |
| Several environments, or large provider sets (AWS, Azure) | 4 vCPU / 8 GB, `concurrent = 4` | Providers load in parallel, so memory is the constraint more than CPU |
| Production isolated from everything else | Its own runner, tag, and credentials | Add a dedicated tag to the production jobs so other jobs can't land there |

These are starting points to benchmark, not guarantees.

### 5.2 Where to host the runner

A Docker-executor runner needs a small VM with outbound-only network access. [DigitalOcean Droplets (affiliate)](https://www.awin1.com/cread.php?awinmid=123996&awinaffid=3152143&ued=https%3A%2F%2Fwww.digitalocean.com%2Fproducts%2Fdroplets) and [Vultr (affiliate)](https://www.vultr.com/?ref=9935169) both offer plain VMs with a firewall and an API, and both have Terraform providers, so you can describe the runner as code once the first one exists. Choose on region, price, and how much you value a simpler console. Compare current pricing on each provider's pricing documentation, such as [DigitalOcean's Droplet pricing](https://docs.digitalocean.com/products/droplets/details/pricing/).

If your infrastructure already lives in AWS, a small EC2 instance inside your VPC can simplify networking and IAM. At this size the saving from another provider is modest, so don't add a second vendor for it alone.

### 5.3 Keep a copy of state outside GitLab

GitLab keeps state versions, but those versions live inside the system your pipeline now depends on. An independent copy protects you from a GitLab-side incident or an accidental project deletion. For infrastructure that runs on AWS, putting that copy on a different provider also gives you a separate failure domain.

[DigitalOcean Spaces (affiliate)](https://www.awin1.com/cread.php?awinmid=123996&awinaffid=3152143&ued=https%3A%2F%2Fwww.digitalocean.com%2Fproducts%2Fspaces) and [Vultr Object Storage (affiliate)](https://www.vultr.com/?ref=9935169) both speak the S3 API. [AWS S3](https://aws.amazon.com/s3/) is the choice if you want Object Lock. Check egress terms before you commit; that's where object-storage bills usually surprise people. The scheduled `state-backup` job in the [architecture guide](/terraform-cloud-alternative-gitlab-ci) automates the ongoing copy.

For the one-time migration backups from Step 1, encrypt before upload. Both the archive and the passphrase prompt stay on your machine:

```bash
tar -C "${REPO_ROOT}/migration" -cz backups \
  | gpg --symmetric --cipher-algo AES256 -o migration-backups.tgz.gpg
aws s3 cp migration-backups.tgz.gpg "s3://${BACKUP_BUCKET}/hcp-migration/" \
  --endpoint-url "${BACKUP_S3_ENDPOINT}"
shred -u migration-backups.tgz.gpg 2>/dev/null || rm -f migration-backups.tgz.gpg
```

Set a lifecycle rule that expires the object after your rollback window, then delete the HCP workspaces on the same day. State files hold secrets in plaintext, so also restrict who can read that bucket.
