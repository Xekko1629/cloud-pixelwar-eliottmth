# Application secrets (SRV-03): containers only, values are added by hand and never
# enter Terraform. They live in this persistent stack because Secret Manager is the
# source of truth: a destroy of serverless must not delete the values. The functions
# get secretAccessor on the secrets they use from infra/serverless (module function).
locals {
  application_secret_ids = toset([
    "discord-public-key",
    "discord-bot-token",
    "discord-application-id",
    "discord-oauth-client-secret",
    "admin-allowlist",
  ])
}

resource "google_secret_manager_secret" "application" {
  for_each = local.application_secret_ids

  secret_id = each.value

  replication {
    auto {}
  }

  labels = {
    project     = "pixelwar"
    environment = var.environment
    managed_by  = "terraform"
  }

  deletion_protection = true

  depends_on = [google_project_service.apis]
}

# Lets infra/serverless grant secretAccessor on these secrets to function identities
resource "google_secret_manager_secret_iam_member" "deployer_application" {
  for_each = local.application_secret_ids

  secret_id = google_secret_manager_secret.application[each.value].id
  role      = google_project_iam_custom_role.deployer_iam_policy["secret"].name
  member    = google_service_account.deployer.member
}

# Secrets created earlier by infra/serverless (dev only); adopted, not recreated.
import {
  for_each = var.import_application_secrets ? local.application_secret_ids : toset([])

  to = google_secret_manager_secret.application[each.value]
  id = "projects/${var.project_id}/secrets/${each.value}"
}
