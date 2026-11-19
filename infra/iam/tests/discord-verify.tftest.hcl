mock_provider "google" {
  mock_data "google_project" {
    defaults = { number = "123456789012" }
  }
  mock_data "google_service_account" {
    defaults = {
      name  = "projects/cloud-pixelwar-dev/serviceAccounts/invoke-e34c8c0323d1f404f6dd@cloud-pixelwar-dev.iam.gserviceaccount.com"
      email = "invoke-e34c8c0323d1f404f6dd@cloud-pixelwar-dev.iam.gserviceaccount.com"
    }
  }
}
mock_provider "google" { alias = "billing" }
mock_provider "github" {}

override_resource { target = google_storage_bucket.tfstate }

override_resource {
  target = google_service_account.deployer
  values = {
    name   = "projects/cloud-pixelwar-dev/serviceAccounts/github-terraform@cloud-pixelwar-dev.iam.gserviceaccount.com"
    email  = "github-terraform@cloud-pixelwar-dev.iam.gserviceaccount.com"
    member = "serviceAccount:github-terraform@cloud-pixelwar-dev.iam.gserviceaccount.com"
  }
}
override_resource {
  target = google_service_account.planner
  values = {
    name   = "projects/cloud-pixelwar-dev/serviceAccounts/github-planner@cloud-pixelwar-dev.iam.gserviceaccount.com"
    email  = "github-planner@cloud-pixelwar-dev.iam.gserviceaccount.com"
    member = "serviceAccount:github-planner@cloud-pixelwar-dev.iam.gserviceaccount.com"
  }
}

variables {
  project_id      = "cloud-pixelwar-dev"
  environment     = "dev"
  billing_account = "000000-000000-000000"
  state_bucket    = "pixelwar-test-tfstate"
}

run "disabled_by_default" {
  command = plan
  assert {
    condition = (
      length(data.google_service_account.discord_verify_invoker) == 0 &&
      length(google_service_account_iam_member.deployer_manages_discord_verify) == 0 &&
      length(google_service_account_iam_member.deployer_uses_discord_verify) == 0 &&
      length(google_service_account_iam_member.planner_reads_discord_verify) == 0 &&
      length(google_project_iam_custom_role.discord_verify_policy_read) == 0
    )
    error_message = "IAM bootstrap must be explicitly enabled after the invoker exists."
  }
}

run "scoped_permissions_for_existing_invoker" {
  command = apply
  variables { enable_discord_verify_iam = true }
  assert {
    condition = (
      data.google_service_account.discord_verify_invoker[0].account_id == "invoke-${substr(sha256("discord-command-verify"), 0, 20)}" &&
      data.google_service_account.discord_verify_invoker[0].project == var.project_id &&
      google_service_account_iam_member.deployer_manages_discord_verify[0].service_account_id == data.google_service_account.discord_verify_invoker[0].name &&
      google_service_account_iam_member.deployer_uses_discord_verify[0].service_account_id == data.google_service_account.discord_verify_invoker[0].name &&
      google_service_account_iam_member.planner_reads_discord_verify[0].service_account_id == data.google_service_account.discord_verify_invoker[0].name
    )
    error_message = "Use a lookup of the sole existing dev invoker and bind all three grants on that resource, not the project."
  }
  assert {
    condition = (
      google_service_account_iam_member.deployer_manages_discord_verify[0].role == google_project_iam_custom_role.deployer_iam_policy["serviceaccount"].name &&
      google_service_account_iam_member.deployer_manages_discord_verify[0].member == google_service_account.deployer.member &&
      google_service_account_iam_member.deployer_uses_discord_verify[0].role == "roles/iam.serviceAccountUser" &&
      google_service_account_iam_member.deployer_uses_discord_verify[0].member == google_service_account.deployer.member &&
      google_service_account_iam_member.planner_reads_discord_verify[0].role == google_project_iam_custom_role.discord_verify_policy_read[0].name &&
      google_service_account_iam_member.planner_reads_discord_verify[0].member == google_service_account.planner.member &&
      toset(google_project_iam_custom_role.discord_verify_policy_read[0].permissions) == toset(["iam.serviceAccounts.getIamPolicy"])
    )
    error_message = "Deployer gets policy management and actAs only here; planner gets only getIamPolicy, never write or impersonation."
  }
}

run "no_discord_iam_in_prd_even_with_flag" {
  command = plan
  variables {
    environment               = "prd"
    project_id                = "cloud-pixelwar-prod"
    enable_discord_verify_iam = true
  }
  assert {
    condition = (
      length(data.google_service_account.discord_verify_invoker) == 0 &&
      length(google_service_account_iam_member.deployer_manages_discord_verify) == 0 &&
      length(google_service_account_iam_member.deployer_uses_discord_verify) == 0 &&
      length(google_service_account_iam_member.planner_reads_discord_verify) == 0 &&
      length(google_project_iam_custom_role.discord_verify_policy_read) == 0
    )
    error_message = "Even an enabled flag must not read or grant any diagnostic invoker permission in prd."
  }
}
