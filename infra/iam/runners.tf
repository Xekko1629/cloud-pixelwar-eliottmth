# GitHub App credentials of the self-hosted runners (infra/runners), only where enable_runners = true.
# Terraform creates the empty secret; its value is added by hand, so it never lands in a state file.

locals {
  runners_count = var.enable_runners ? 1 : 0
}

resource "google_secret_manager_secret" "arc_github_app" {
  count = local.runners_count

  secret_id = "arc-github-app"

  replication {
    auto {}
  }

  depends_on = [google_project_service.apis]
}

# Identity of External Secrets Operator in the cluster, which copies the secret into Kubernetes
resource "google_service_account" "external_secrets" {
  count = local.runners_count

  account_id   = "external-secrets"
  display_name = "External Secrets Operator (runners cluster)"

  depends_on = [google_project_service.apis]
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

# Lets the runners stack add the Workload Identity binding of External Secrets
# (it needs the cluster's identity pool, so it cannot live here), and nothing else:
# no create, update or delete of the account.
resource "google_service_account_iam_member" "deployer_manages_external_secrets" {
  count = local.runners_count

  service_account_id = google_service_account.external_secrets[0].name
  role               = google_project_iam_custom_role.deployer_iam_policy["serviceaccount"].name
  member             = google_service_account.deployer.member
}
