mock_provider "google" {
  mock_data "google_project" {
    defaults = { number = "123456789012" }
  }
}
mock_provider "google" {
  alias = "billing"
}
mock_provider "github" {}

# The state bucket is imported, and mock providers cannot import
override_resource {
  target = google_storage_bucket.tfstate
}

variables {
  project_id      = "cloud-pixelwar-dev"
  environment     = "dev"
  billing_account = "000000-000000-000000"
  state_bucket    = "pixelwar-test-tfstate"
}

run "apis_in_one_place" {
  command = plan

  assert {
    condition = alltrue([
      for api in ["container.googleapis.com", "secretmanager.googleapis.com", "sts.googleapis.com", "cloudfunctions.googleapis.com", "pubsub.googleapis.com"] :
      contains(keys(google_project_service.apis), api)
    ])
    error_message = "Every API of the project, cluster and application included, is enabled by this stack."
  }

  assert {
    condition     = alltrue([for api in google_project_service.apis : api.disable_on_destroy == false])
    error_message = "Removing an API from this stack must never disable it."
  }
}

run "persistent_application_secrets" {
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
    condition     = alltrue([for secret in google_secret_manager_secret.application : secret.deletion_protection && secret.labels["environment"] == "dev"])
    error_message = "Application secrets are the source of truth: protected from deletion."
  }
}

run "deployer_iam_is_resource_scoped" {
  command = plan

  assert {
    condition = (
      toset(google_project_iam_custom_role.deployer_iam_policy["secret"].permissions) == toset(["secretmanager.secrets.getIamPolicy", "secretmanager.secrets.setIamPolicy"]) &&
      toset(google_project_iam_custom_role.deployer_iam_policy["serviceaccount"].permissions) == toset(["iam.serviceAccounts.getIamPolicy", "iam.serviceAccounts.setIamPolicy"])
    )
    error_message = "The deployer may only manage IAM policies, nothing else on these resources."
  }

  assert {
    condition     = length(google_secret_manager_secret_iam_member.deployer_application) == 5
    error_message = "The secret IAM role is bound on each application secret, not on the project."
  }
}

run "state_bucket_is_private_and_kept" {
  command = plan

  assert {
    condition = (
      google_storage_bucket.tfstate.name == "pixelwar-test-tfstate" &&
      google_storage_bucket.tfstate.public_access_prevention == "enforced" &&
      google_storage_bucket.tfstate.uniform_bucket_level_access &&
      !google_storage_bucket.tfstate.force_destroy &&
      google_storage_bucket.tfstate.versioning[0].enabled
    )
    error_message = "The state bucket must stay private, versioned and non-destructible."
  }
}

run "runners_identities_prd" {
  command = plan

  variables {
    project_id     = "cloud-pixelwar-prod"
    environment    = "prd"
    enable_runners = true
  }

  override_resource {
    target          = google_project_iam_custom_role.deployer_iam_policy
    override_during = plan
    values          = { name = "projects/cloud-pixelwar-prod/roles/deployerIamPolicy" }
  }

  assert {
    condition     = google_service_account_iam_member.deployer_manages_external_secrets[0].role == "projects/cloud-pixelwar-prod/roles/deployerIamPolicy"
    error_message = "The deployer must not be able to delete or modify the External Secrets account."
  }
}
