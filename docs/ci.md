# CI/CD

## Application tests (TEST-01)

Every PR to `prod` also runs `_app-test.yml`: Node.js 24 strict type checks,
Vitest unit tests with a 70% per-file coverage threshold, then integration tests
against local Firestore and Pub/Sub emulators (Java 21). No cloud credentials
are used. Coverage is published in the run summary and reports are uploaded as
artifacts. `CI result` depends on this job, so failures block the required check.
See [testing.md](testing.md) for local commands, limitations and dependency alerts.

BOT-02 provides the Discord command registration tool and its
[post-deployment integration contract](discord-commands.md). It is not yet wired
to this infrastructure workflow; SRV-02 must call it after a successful
application deployment, with environment-scoped credentials. PR tests never
register real Discord commands.

## GitFlow

- `prod`: default branch, always deployable, protected (PR + review + green checks + signed commits).
- `feature/*`: short-lived branches created from `prod`, one change each.
- Releases are tags `vX.Y.Z` (semantic versioning) created on `prod`.

| Event | Checks | Plan dev + prd | Apply dev | Apply prd |
|---|---|---|---|---|
| PR `feature/*` → `prod` (`ci.yml`) | ✅ | ✅ | — | — |
| Manual run of `deploy.yml` from any branch | ✅ | — | foundation + bootstrap → serverless | — |
| Tag `v*` pushed (`deploy.yml`) | ✅ | — | foundation + bootstrap → serverless | foundation + bootstrap, then serverless and runners in parallel, after dev |
| Manual run of `destroy.yml` | — | — | destroy dev or prd: serverless and runners (prd only), then foundation; bootstrap is kept | |

Checks: `terraform fmt -check`, `tflint` (rules in `.tflint.hcl`), `terraform validate` and `terraform test` (`*.tftest.hcl`) on each stack.
Any failure stops the pipeline before plan or apply.

PR checks select changed directories: `foundation`, `iam`, `access`, `runners`,
`bootstrap`, `serverless`, `serverless/modules/function`, `serverless/modules/api-gateway` and
`serverless/modules/function-source`. The module entries run their mock-provider tests independently,
since the root stack does not discover them. A change in `app/functions`, `app/shared/src` or
`app/package-lock.json` also re-plans `serverless`.
Remote PR plans cover `foundation` and `serverless` (dev and prd), when that stack changes. Release
validation/tests also cover `bootstrap`, `serverless` and its modules by
default. Deploy now applies `foundation` then `serverless` in each environment;
destroy removes `serverless` before runners (prd) and `foundation`. Application
secrets, the state bucket and every API live in `iam`, which is preserved, as is
the bootstrap (registry, source bucket and build identity): their contents survive
a destroy. Before any plan or apply of `serverless`, the CI builds the functions (`npm run build:functions`); Terraform zips and uploads them: see [functions.md](functions.md).
See [the secrets runbook](../infra/iam/SECRETS.md) before
triggering a workflow. Each apply job computes then applies its own plan without
an intervening review pause; review the PR plans before tagging.

## Workflows

### Accès humains (appliqués à la main)

`infra/access` n'est appliqué par aucun workflow, ni en dev ni en prd : Xekko
l'applique en local avec ses identifiants, comme `infra/iam`. Il gère les rôles
`editor` de l'équipe et de l'instructeur, le `billing.viewer` de l'instructeur
(prd) et la lecture des deux secrets Discord dev. Aucune identité de CI n'a le
droit de modifier l'IAM d'un projet. Voir le [runbook access](../infra/access/README.md).
Les states IAM/access sont persistants et ne sont ciblés ni par Deploy ni par
Destroy, pas plus que les secrets applicatifs (gérés par `infra/iam`) : les
attributions de lecture survivent donc à un destroy.

Le filtre de PR et les contrôles locaux de release incluent maintenant `access`.
Ils n'appliquent pas de droits ; aucune authentification GCP dans ces tests simulés.

```
.github/workflows/
├── ci.yml          # PR → prod: fmt + validate + test → plan dev + prd (foundation, serverless)
├── deploy.yml      # foundation + serverless dev, then foundation prd → serverless + runners (tag only)
├── destroy.yml     # typed confirmation; serverless + runners (prd only), then foundation
├── _fmt.yml        # reusable steps, never run directly
├── _lint.yml
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
- **Runner**: every job runs on the `runner` input if set, then on the `RUNNER_LABEL` repository variable, then on `ubuntu-latest`.
  See [Self-hosted runners](#self-hosted-runners) for the exceptions.

## Path filtering (pull requests only)

On a PR, `ci.yml` only checks the stacks whose directory changed (job `changes`, `dorny/paths-filter`).
A change under `.github/workflows/` or to `.tflint.hcl` re-checks every stack.

| PR changes… | fmt / lint | validate / test | plan dev + prd |
|---|---|---|---|
| nothing under `infra/` or `.github/workflows/` (e.g. `docs/`) | skipped | skipped | skipped |
| `infra/iam/**` | ✅ | iam | skipped (never applied by the CI) |
| `infra/foundation/**` | ✅ | foundation | ✅ |
| `infra/bootstrap/**` | ✅ | bootstrap | ✅ |
| `infra/serverless/**` | ✅ | serverless (+ module) | ✅ |
| `infra/access/**` | ✅ | access | skipped (applied by hand) |
| `infra/runners/**` | ✅ | runners | skipped (see below) |
| `.github/workflows/**` or `.tflint.hcl` | ✅ | all stacks | ✅ |

The **`CI result`** job always runs and fails if any other job failed. It is the check to mark as required on `prod`.

To add a stack, add an entry to the `filters` of the `changes` job.
`deploy.yml` and `destroy.yml` are not path-filtered: they process their explicitly
listed stacks, not every directory under `infra/`. A new directory is not
automatically deployed. A merge/push to `prod` alone does not trigger Deploy.

## Authentication: Workload Identity Federation

No cloud key is stored in GitHub. Each job gets a short-lived OIDC token, and GCP exchanges it for temporary credentials only if it comes from this repository **and** the right GitHub environment.

Each GCP project has two service accounts:

| Service account | Roles | Usable from GitHub environment | Used by |
|---|---|---|---|
| `github-terraform` (deployer) | `roles/editor`, `roles/resourcemanager.projectIamAdmin`, `roles/container.admin` | `<env>` | apply, destroy |
| `github-planner` (read-only) | `roles/viewer` | `<env>-plan` | PR plans |

Both are created by the `infra/iam` stack. Their project roles also give them access to the state bucket
(GCP grants `projectEditor` write and `projectViewer` read on objects by default).

The deployer also gets two custom roles bound **per resource**, never on the project (`deployer-iam.tf`):
`getIamPolicy`/`setIamPolicy` on each application secret, so that `infra/serverless` can grant
`secretAccessor` to a function, and on the `external-secrets` service account, so that `infra/runners`
can add its Workload Identity binding. It cannot create, update or delete these resources.

PR plans run with the read-only identity and `-lock=false`. A PR can therefore never modify an environment, and `prd` approvals are only requested for real deploys.

## One-time setup

### 1. Apply `infra/iam` by hand (once per environment)

The `infra/iam` stack creates, for one environment:

- **in GCP**: every API of the project, the state bucket (imported, `prevent_destroy`), the Workload Identity
  pool and provider, the `github-terraform` and `github-planner` service accounts, the budget, and the
  Secret Manager containers (application secrets and, in prd, `arc-github-app`), without values;
- **in GitHub**: the `<env>` and `<env>-plan` environments, with their `WIF_PROVIDER` and `DEPLOYER_SA` variables.
  For `prd`, it also requires a reviewer and only allows deploys from the `prod` branch and `v*` tags (see `prd.tfvars`).

It lives in its own stack so that destroying `foundation` never removes the CI identities.
The CI only checks this stack (fmt, validate, test) and never applies it: the CI cannot create the identity it uses to log in.
Apply it by hand, with your own accounts, once per environment and whenever `infra/iam` changes.
`just manual` (or `scripts/apply-manual.sh [dev|prd|all] [iam|access|all]`) runs `iam` then `access`
for each environment: it checks that HEAD is `origin/prod`, sets `GITHUB_TOKEN` from `gh`, shows each
plan and applies it only after confirmation, and requires typing `destroy` when a plan deletes or replaces.
The GitHub token must belong to a repository admin.

```sh
cd infra/iam
export GITHUB_TOKEN=$(gh auth token)

terraform init -reconfigure -backend-config=backends/dev.hcl
terraform apply -var-file=dev.tfvars

terraform init -reconfigure -backend-config=backends/prd.hcl
terraform apply -var-file=prd.tfvars
```

Apply `infra/iam` before any CI deploy: it enables every API and gives the deployer the
`deployerResourceIamPolicy` role (IAM policies of buckets, registries, functions, Cloud Run
services and Pub/Sub, which `roles/editor` lacks) and the planner `plannerResourceIamRead`.
Every other stack except `access` (also applied by hand) is then deployed by the CI;
`bootstrap` is applied by Deploy but never destroyed.

### 2. Self-hosted runners (prd)

See [Self-hosted runners](#self-hosted-runners): create the GitHub App and add the secret version once `infra/iam` (prd) is applied.

### 3. Branch protection on `prod`

Require a pull request with 1 approval, the `CI result` check passing, and signed commits.

The **Run workflow** button of `deploy.yml` and `destroy.yml` only appears once they are on `prod`, the default branch.

## Self-hosted runners

Stack `infra/runners`, deployed in **prd only**, on the GKE cluster of `infra/foundation` (`enable_cluster = true` in prd).

```
Secret Manager "arc-github-app"  (GitHub App credentials, added by hand)
      │  Workload Identity (KSA external-secrets/external-secrets → GSA external-secrets)
      ▼
External Secrets Operator (Helm, ns external-secrets) ──► Kubernetes secret "arc-github-app" (ns arc-runners)
                                                                │
Actions Runner Controller (Helm, ns arc-systems)                ▼
Runner scale set "pixelwar-runners" (Helm, ns arc-runners) ──► registers on the repository
      │  one ephemeral pod per job: nodeSelector pool=runners + toleration dedicated=runners
      ▼
Node pool "runners": 0 → 3 nodes (GKE cluster autoscaler)
```

- **Helm through Terraform**: `helm_release` with pinned chart versions and values in `infra/runners/values/<chart>-<env>.yaml[.tftpl]`.
- **Dynamic registration**: runners are ephemeral. ARC creates a runner per job and removes it afterwards; destroying the release removes the scale set from GitHub (no stale registration).
- **Node autoscaling**: a pending runner pod makes the `runners` pool grow (0 → 3); idle nodes are removed (`OPTIMIZE_UTILIZATION` profile).

### Job routing

| Job | Runner |
|---|---|
| fmt, validate, test, plan (every stack) | `RUNNER_LABEL` if set, otherwise `ubuntu-latest` |
| apply / destroy of `foundation` and `runners` | always `ubuntu-latest`: they create, change or delete the runners themselves |

`RUNNER_LABEL` (repository variable) is created by `infra/runners` once the scale set is installed, and deleted on destroy:
the first deploy and any run after a destroy use `ubuntu-latest`, then jobs move to the self-hosted runners automatically.
If the runners are broken while the variable exists, jobs stay queued: run a workflow with `runner = ubuntu-latest`,
or `gh variable delete RUNNER_LABEL` until the next apply of `infra/runners`.

PRs do not plan `infra/runners` (fmt, validate and test only): refreshing Helm releases reads Kubernetes secrets,
which the read-only planner must not access. Its plan is shown in the apply job of each release.

### GitHub App (one-time, manual)

1. Create a GitHub App owned by the repository owner. Repository permissions: *Administration: read & write* (self-hosted runners),
   *Variables: read & write* (`RUNNER_LABEL`), *Metadata: read*. No webhook. Install it on this repository only.
2. Apply `infra/iam` in prd (creates the empty `arc-github-app` secret), then add its value:

   ```sh
   # arc-github-app.json:
   # {"github_app_id": "<Client ID>", "github_app_installation_id": "<installation ID>", "github_app_private_key": "<content of the .pem>"}
   gcloud secrets versions add arc-github-app --project=cloud-pixelwar-prod --data-file=arc-github-app.json
   rm arc-github-app.json <app>.private-key.pem
   ```

The key is never in the repository, a Terraform state or GitHub secrets: External Secrets Operator reads it in the cluster,
and the deploy jobs of `infra/runners` read it in memory to mint a one-hour GitHub App token (`actions/create-github-app-token`).

### Cost safety

- `runners` node pool: `e2-standard-2`, 0 to 6 nodes; runner pods request 1 vCPU / 2 GiB (about one runner per node), `maxRunners: 6`. The cap keeps the cluster within the 16 vCPU quota (see [GCP projects and costs](gcp.md)).
- `system` node pool: one spot `e2-medium` for the controller and system pods.
- Budget alerts per project (`infra/iam/budget.tf`): 20 EUR, emails at 50 %, 90 % and 100 % (see [GCP projects and costs](gcp.md)).
- Runner activity: Cloud Logging, `resource.type="k8s_container" AND resource.labels.namespace_name=("arc-runners" OR "arc-systems")`.
