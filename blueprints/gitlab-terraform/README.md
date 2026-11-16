# GitLab Terraform Blueprint

A drop-in replacement for the core of HCP Terraform (Terraform Cloud): GitLab-managed
state, OIDC cloud auth with no stored keys, encrypted saved plans, a manual and gated
apply, scheduled drift detection, and optional Prometheus/Loki reporting.

Full explanation and trade-offs: <https://cloudnativecraft.com/terraform-cloud-alternative-gitlab-ci>
Migrating existing HCP state: <https://cloudnativecraft.com/migrating-hcp-terraform-to-gitlab-ci>

## Layout

```text
.
├── .gitlab-ci.yml
├── ci/
│   └── observability.gitlab-ci.yml
└── infra/
    ├── backend.tf              # terraform { backend "http" {} }
    ├── main.tf
    └── .terraform.lock.hcl     # committed
```

## Setup

1. Copy `.gitlab-ci.yml` and `ci/` to your repository root. Put your Terraform in `infra/`.
2. Add `terraform { backend "http" {} }` to `infra/backend.tf`. The block stays empty: the
   pipeline supplies address, lock endpoints, and credentials through `TF_HTTP_*`.
3. Create the CI/CD variables below (Settings → CI/CD → Variables).
4. Protect the default branch and the `production` environment (see the guide).
5. Create a pipeline schedule with `SCHEDULE_TYPE=drift` for drift detection.

## CI/CD variables

| Variable | Flags | Required | Purpose |
|---|---|---|---|
| `PLAN_ENC_KEY` | Masked, Protected | Yes | Passphrase for encrypting saved plans (`openssl rand -base64 32`) |
| `AWS_ROLE_ARN_PLAN` | Protected | Yes | Read-only role for default-branch plans and drift checks |
| `AWS_ROLE_ARN_APPLY` | Protected | Yes | Write-capable role for applies |
| `AWS_ROLE_ARN_MR` | none | Yes | Read-only role for same-project merge request plans |
| `PUSHGATEWAY_URL`, `PUSHGATEWAY_AUTH` | Masked | No | Prometheus Pushgateway; `PUSHGATEWAY_AUTH` is `user:pass` |
| `LOKI_URL`, `LOKI_AUTH` | Masked | No | Loki push endpoint; `LOKI_AUTH` is `user:pass` |

The blueprint uses AWS OIDC. For another cloud, change the `id_tokens` audience and the
credential wiring in `.tf_auth`; the rest of the pipeline is cloud-neutral.

## Notes

- Pin the Terraform image to the version your state was last written with. Upgrade separately.
- Several environments: use one state name per environment. The migration guide shows the pattern.
- Protected environments are a GitLab Premium/Ultimate feature. On Free, rely on branch protection.
- Never print or `set -x` in jobs that handle the OIDC token or the decrypted plan.

License: choose and add one before publishing this directory (MIT or Apache-2.0 are typical).
