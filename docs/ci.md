# CI/CD

## GitFlow

- `prod`: default branch, always deployable, protected (PR + review + green checks + signed commits).
- `feature/*`: short-lived branches created from `prod`, one change each.
- Releases are tags `vX.Y.Z` (semantic versioning) created on `prod`.

| Event | Checks | Plan dev + prd | Apply dev | Apply prd |
|---|---|---|---|---|
| PR `feature/*` → `prod` (`ci.yml`) | ✅ | ✅ | — | — |
| Manual run of `deploy.yml` from any branch | ✅ | — | ✅ | — |
| Tag `v*` pushed (`deploy.yml`) | ✅ | — | ✅ | ✅ after dev |
| Manual run of `destroy.yml` | — | — | destroy dev or prd | |

Checks: `terraform fmt -check`, `terraform validate` and `terraform test` (`*.tftest.hcl`) on each stack.
Any failure stops the pipeline before plan or apply.

## Workflows

```
.github/workflows/
├── ci.yml          # PR → prod: fmt + validate + test → plan dev + prd
├── deploy.yml      # tag v*: … → apply dev → apply prd / manual: … → apply dev
├── destroy.yml     # manual: destroy dev or prd (typed confirmation)
├── _fmt.yml        # reusable steps, never run directly
├── _validate.yml
├── _test.yml
├── _plan.yml
├── _apply.yml
└── _destroy.yml
```

- Environment-specific values come from `backends/<env>.hcl`, `<env>.tfvars` and the GitHub environment variables. `<env>` is `dev` or `prd`.
- `_apply.yml` refuses to apply `prd` from a commit that is not on `prod`.
- Apply and destroy never run concurrently on the same environment and stack.
- Plans are written to the run summary.
- **Runner**: every job runs on the `runner` input if set, then on the `RUNNER_LABEL` repository variable, then on `ubuntu-latest`. Set `RUNNER_LABEL` to switch to the self-hosted runners (C04).

## Authentication: Workload Identity Federation

No cloud key is stored in GitHub. Each job gets a short-lived OIDC token, and GCP exchanges it for temporary credentials only if it comes from this repository **and** the right GitHub environment.

Each GCP project has two service accounts:

| Service account | Roles | Usable from GitHub environment | Used by |
|---|---|---|---|
| `github-terraform` (deployer) | `roles/editor`, `roles/resourcemanager.projectIamAdmin` | `<env>` | apply, destroy |
| `github-planner` (read-only) | `roles/viewer` | `<env>-plan` | PR plans |

Both are created by the `infra/iam` stack. Their project roles also give them access to the state bucket
(GCP grants `projectEditor` write and `projectViewer` read on objects by default).

PR plans run with the read-only identity and `-lock=false`. A PR can therefore never modify an environment, and `prd` approvals are only requested for real deploys.

## One-time setup

### 1. Apply `infra/iam` by hand (once per environment)

The `infra/iam` stack creates, for one environment:

- **in GCP**: the Workload Identity pool and provider, and the `github-terraform` and `github-planner` service accounts;
- **in GitHub**: the `<env>` and `<env>-plan` environments, with their `WIF_PROVIDER` and `DEPLOYER_SA` variables.
  For `prd`, it also requires a reviewer and only allows deploys from the `prod` branch and `v*` tags (see `prd.tfvars`).

It lives in its own stack so that destroying `foundation` never removes the CI identities.
The CI only checks this stack (fmt, validate, test) and never applies it: the CI cannot create the identity it uses to log in.
Apply it by hand, with your own accounts, once per environment and whenever `infra/iam` changes.
The GitHub token must belong to a repository admin.

```sh
cd infra/iam
export GITHUB_TOKEN=$(gh auth token)

terraform init -reconfigure -backend-config=backends/dev.hcl
terraform apply -var-file=dev.tfvars

terraform init -reconfigure -backend-config=backends/prd.hcl
terraform apply -var-file=prd.tfvars
```

Every other stack is then deployed by the CI.

### 2. Optional repository variable

`RUNNER_LABEL`: runner used by every job (default `ubuntu-latest`).

### 3. Branch protection on `prod`

Require a pull request with 1 approval, the `CI` checks passing, and signed commits.

The **Run workflow** button of `deploy.yml` and `destroy.yml` only appears once they are on `prod`, the default branch.
