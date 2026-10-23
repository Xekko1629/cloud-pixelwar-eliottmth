mock_provider "google" {}

variables {
  project_id  = "pixelwar-test"
  environment = "dev"
}

run "secret_definitions" {
  command = plan

  assert {
    condition = toset(keys(google_secret_manager_secret.application)) == toset([
      "discord-public-key",
      "discord-bot-token",
      "discord-application-id",
      "discord-oauth-client-secret",
      "admin-allowlist",
    ])
    error_message = "Declare the five application secret containers."
  }

  assert {
    condition     = alltrue([for id, secret in google_secret_manager_secret.application : secret.project == "pixelwar-test" && secret.secret_id == id && secret.labels["environment"] == "dev"])
    error_message = "Each secret must use the selected project, ID and environment."
  }

  assert {
    condition     = alltrue([for secret in google_secret_manager_secret.application : secret.deletion_policy == "DELETE"])
    error_message = "Application secrets must remain destructible with their stack."
  }
}

run "production_secrets" {
  command = plan

  variables {
    project_id  = "pixelwar-prod-test"
    environment = "prd"
  }

  assert {
    condition     = alltrue([for secret in google_secret_manager_secret.application : secret.project == "pixelwar-prod-test" && secret.labels["environment"] == "prd"])
    error_message = "Production must use its own project and labels."
  }
}
