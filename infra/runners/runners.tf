# Self-hosted GitHub Actions runners (Actions Runner Controller), deployed with Helm on the cluster of infra/foundation.
# GitHub App credentials: Secret Manager "arc-github-app" (infra/iam) → External Secrets Operator → Kubernetes secret.

locals {
  github_owner = split("/", var.github_repository)[0]
  github_repo  = split("/", var.github_repository)[1]

  external_secrets_namespace = "external-secrets"
  arc_controller_namespace   = "arc-systems"
  arc_runners_namespace      = "arc-runners"
  arc_github_secret          = "arc-github-app"
}

# External Secrets Operator

data "google_service_account" "external_secrets" {
  account_id = "external-secrets"
}

# Workload Identity: the operator's Kubernetes service account acts as the external-secrets GCP account
resource "google_service_account_iam_member" "external_secrets_workload_identity" {
  service_account_id = data.google_service_account.external_secrets.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "serviceAccount:${var.project_id}.svc.id.goog[${local.external_secrets_namespace}/external-secrets]"
}

resource "helm_release" "external_secrets" {
  name             = "external-secrets"
  repository       = "https://charts.external-secrets.io"
  chart            = "external-secrets"
  version          = var.external_secrets_chart_version
  namespace        = local.external_secrets_namespace
  create_namespace = true

  values = [templatefile("${path.module}/values/external-secrets-${var.environment}.yaml.tftpl", {
    gcp_service_account = data.google_service_account.external_secrets.email
  })]

  depends_on = [google_service_account_iam_member.external_secrets_workload_identity]
}

# SecretStore + ExternalSecret creating the Kubernetes secret read by the runner scale set
resource "helm_release" "arc_github_secret" {
  name             = "arc-github-secret"
  chart            = "${path.module}/charts/arc-github-secret"
  namespace        = local.arc_runners_namespace
  create_namespace = true

  values = [yamlencode({
    projectId           = var.project_id
    secretManagerSecret = "arc-github-app"
    kubernetesSecret    = local.arc_github_secret
  })]

  depends_on = [helm_release.external_secrets]
}

# Actions Runner Controller

resource "helm_release" "arc_controller" {
  name             = "arc"
  repository       = "oci://ghcr.io/actions/actions-runner-controller-charts"
  chart            = "gha-runner-scale-set-controller"
  version          = var.arc_chart_version
  namespace        = local.arc_controller_namespace
  create_namespace = true

  values = [file("${path.module}/values/controller-${var.environment}.yaml")]
}

# Registers runners dynamically on the repository: one ephemeral pod per job, removed afterwards.
# One scale set per size class (small, medium), so light jobs do not reserve a whole node.
resource "helm_release" "arc_runner_set" {
  for_each = var.runner_sets

  name             = each.value.name
  repository       = "oci://ghcr.io/actions/actions-runner-controller-charts"
  chart            = "gha-runner-scale-set"
  version          = var.arc_chart_version
  namespace        = local.arc_runners_namespace
  create_namespace = true
  wait             = true

  values = [templatefile("${path.module}/values/runners-${var.environment}.yaml.tftpl", {
    github_config_url     = "https://github.com/${var.github_repository}"
    github_config_secret  = local.arc_github_secret
    runner_scale_set_name = each.value.name
    min_runners           = each.value.min_runners
    max_runners           = each.value.max_runners
    cpu_request           = each.value.cpu
    memory_request        = each.value.memory
    memory_limit          = each.value.memory_limit
    controller_namespace  = local.arc_controller_namespace
    # Service account of the controller chart: "<release name>-gha-rs-controller"
    controller_service_account = "${helm_release.arc_controller.name}-gha-rs-controller"
  })]

  depends_on = [helm_release.arc_controller, helm_release.arc_github_secret]
}

# Routes CI jobs to these runners (runs-on: vars.RUNNER_SMALL / vars.RUNNER_MEDIUM || 'ubuntu-latest').
# Removed on destroy, which sends every job back to GitHub-hosted runners.
resource "github_actions_variable" "runner_label" {
  for_each = var.runner_sets

  repository    = local.github_repo
  variable_name = "RUNNER_${upper(each.key)}"
  value         = each.value.name

  depends_on = [helm_release.arc_runner_set]
}

# Migration from the single pixelwar-runners scale set: the old helm release and the
# RUNNER_LABEL variable have no instance key, so the next apply deletes them and creates
# one release and one variable per class. Jobs fall back to GitHub-hosted runners meanwhile.
