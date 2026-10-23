locals {
  # Resource definitions only. Secret values/versions are supplied outside Terraform.
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

  project   = var.project_id
  secret_id = each.value

  replication {
    auto {}
  }

  labels = {
    project     = "pixelwar"
    environment = var.environment
    managed_by  = "terraform"
  }

  # Keep application resources disposable. Destroy also deletes stored versions.
  deletion_policy = "DELETE"
}
