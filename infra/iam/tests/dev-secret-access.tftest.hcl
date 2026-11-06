mock_provider "google" {
  mock_data "google_project" {
    defaults = { number = "123456789012" }
  }
}
mock_provider "google" {
  alias = "billing"
}
mock_provider "github" {
  mock_data "github_user" {
    defaults = { id = "72801984" }
  }
  mock_data "github_repository" {
    defaults = { repo_id = 123456789 }
  }
}

variables {
  project_id      = "cloud-pixelwar-dev"
  environment     = "dev"
  billing_account = "000000-000000-000000"
}

run "disabled_by_default" {
  command = plan
  assert {
    condition = (
      length(google_service_account.dev_access) == 0 &&
      length(google_storage_bucket.dev_access_state) == 0 &&
      length(google_secret_manager_secret_iam_member.dev_access) == 0 &&
      length(google_project_iam_member.dev_access_project) == 0 &&
      length(github_repository_environment.dev_access) == 0
    )
    error_message = "The new automation must be opt-in, not silently deployed in every environment."
  }
}

run "dev_bootstrap_is_scoped" {
  command = plan
  variables {
    enable_dev_secret_access = true
  }
  assert {
    condition = (
      length(google_service_account.dev_access) == 2 &&
      length(google_secret_manager_secret_iam_member.dev_access) == 4 &&
      length(google_storage_bucket_iam_member.dev_access_state) == 2
    )
    error_message = "Separate plan/apply accounts must be scoped to two secrets and one state bucket."
  }
  assert {
    condition = (
      toset(google_project_iam_custom_role.dev_access["plan"].permissions) == toset(["secretmanager.secrets.getIamPolicy"]) &&
      toset(google_project_iam_custom_role.dev_access["apply"].permissions) == toset([
        "secretmanager.secrets.getIamPolicy", "secretmanager.secrets.setIamPolicy",
      ])
    )
    error_message = "Do not give automation value access, secret writes, project IAM admin or Editor."
  }
  assert {
    condition = (
      toset(google_project_iam_custom_role.dev_access_project["plan"].permissions) == toset(["resourcemanager.projects.getIamPolicy"]) &&
      toset(google_project_iam_custom_role.dev_access_project["apply"].permissions) == toset([
        "resourcemanager.projects.getIamPolicy", "resourcemanager.projects.setIamPolicy",
      ]) &&
      length(google_project_iam_member.dev_access_project["plan"].condition) == 0 &&
      google_project_iam_member.dev_access_project["apply"].condition[0].expression == "api.getAttribute('iam.googleapis.com/modifiedGrantsByRole', []).hasOnly(['roles/editor'])"
    )
    error_message = "Project IAM: plan reads only, apply may only change roles/editor bindings."
  }
  assert {
    condition = alltrue([
      for grant in google_secret_manager_secret_iam_member.dev_access :
      grant.project == "cloud-pixelwar-dev" && contains(["discord-bot-token", "discord-application-id"], grant.secret_id)
    ])
    error_message = "OAuth/admin/prd secrets are outside this bootstrap."
  }
  assert {
    condition = (
      google_storage_bucket.dev_access_state[0].name == "cloud-pixelwar-eliottmth-dev-access-tfstate" &&
      google_storage_bucket.dev_access_state[0].uniform_bucket_level_access &&
      google_storage_bucket.dev_access_state[0].public_access_prevention == "enforced" &&
      !google_storage_bucket.dev_access_state[0].force_destroy &&
      google_storage_bucket.dev_access_state[0].versioning[0].enabled
    )
    error_message = "The access backend must be isolated, private and persistent."
  }
  assert {
    condition = (
      strcontains(google_iam_workload_identity_pool_provider.dev_access[0].attribute_condition, "assertion.repository == 'Xekko1629/cloud-pixelwar-eliottmth'") &&
      strcontains(google_iam_workload_identity_pool_provider.dev_access[0].attribute_condition, "assertion.repository_id == '123456789'") &&
      strcontains(google_iam_workload_identity_pool_provider.dev_access[0].attribute_condition, "assertion.repository_owner_id == '72801984'") &&
      strcontains(google_iam_workload_identity_pool_provider.dev_access[0].attribute_condition, "assertion.ref == 'refs/heads/prod'") &&
      strcontains(google_iam_workload_identity_pool_provider.dev_access[0].attribute_condition, "assertion.event_name == 'workflow_dispatch'") &&
      strcontains(google_iam_workload_identity_pool_provider.dev_access[0].attribute_condition, ".github/workflows/access-dev.yml@refs/heads/prod") &&
      strcontains(google_iam_workload_identity_pool_provider.dev_access[0].attribute_condition, "['access-dev-plan', 'access-dev']")
    )
    error_message = "WIF must reject other repos, branches, workflow files, events and environments."
  }
  assert {
    condition = (
      github_repository_environment.dev_access["apply"].environment == "access-dev" &&
      github_repository_environment.dev_access["apply"].reviewers[0].users == toset([72801984]) &&
      !github_repository_environment.dev_access["apply"].can_admins_bypass &&
      github_repository_environment_deployment_policy.dev_access["apply"].branch_pattern == "prod" &&
      github_repository_environment.dev_access["plan"].environment == "access-dev-plan" &&
      length(github_repository_environment.dev_access["plan"].reviewers) == 0
    )
    error_message = "Only Xekko may approve apply; plan must run before that approval and only from prod."
  }
}

run "prd_has_no_new_automation" {
  command = plan
  variables {
    project_id  = "cloud-pixelwar-prod"
    environment = "prd"
  }
  assert {
    condition     = length(google_service_account.dev_access) == 0 && length(google_storage_bucket.dev_access_state) == 0
    error_message = "Normal prd IAM runs must not create these identities or a state bucket."
  }
}

run "reject_prd_enablement" {
  command = plan
  variables {
    project_id               = "cloud-pixelwar-prod"
    environment              = "prd"
    enable_dev_secret_access = true
  }
  expect_failures = [var.enable_dev_secret_access]
}
