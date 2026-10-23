# GitHub App credentials of the self-hosted runners (infra/runners), only where enable_runners = true.
# Terraform creates the empty secret; its value is added by hand, so it never lands in a state file.

locals {
  runners_count = var.enable_runners ? 1 : 0
}

resource "google_project_service" "secretmanager" {
  count = local.runners_count

  service            = "secretmanager.googleapis.com"
  disable_on_destroy = false
}

resource "google_secret_manager_secret" "arc_github_app" {
  count = local.runners_count

  secret_id = "arc-github-app"

  replication {
    auto {}
  }

  depends_on = [google_project_service.secretmanager]
}

# Identity of External Secrets Operator in the cluster, which copies the secret into Kubernetes
resource "google_service_account" "external_secrets" {
  count = local.runners_count

  account_id   = "external-secrets"
  display_name = "External Secrets Operator (runners cluster)"

  depends_on = [google_project_service.ci]
}

resource "google_secret_manager_secret_iam_member" "external_secrets" {
  count = local.runners_count

  secret_id = google_secret_manager_secret.arc_github_app[0].id
  role      = "roles/secretmanager.secretAccessor"
  member    = google_service_account.external_secrets[0].member
}

# The deployer mints a short-lived GitHub App token to manage RUNNER_LABEL
resource "google_secret_manager_secret_iam_member" "deployer" {
  count = local.runners_count

  secret_id = google_secret_manager_secret.arc_github_app[0].id
  role      = "roles/secretmanager.secretAccessor"
  member    = google_service_account.deployer.member
}

# Lets the runners stack bind the Kubernetes service account of External Secrets to this account only
resource "google_service_account_iam_member" "deployer_manages_external_secrets" {
  count = local.runners_count

  service_account_id = google_service_account.external_secrets[0].name
  role               = "roles/iam.serviceAccountAdmin"
  member             = google_service_account.deployer.member
}
