locals {
  deploy_environment = var.environment
  plan_environment   = "${var.environment}-plan"
}

resource "google_project_service" "ci" {
  for_each = toset([
    "cloudresourcemanager.googleapis.com",
    "iam.googleapis.com",
    "iamcredentials.googleapis.com",
    "sts.googleapis.com",
  ])

  service            = each.value
  disable_on_destroy = false
}

resource "google_iam_workload_identity_pool" "github" {
  workload_identity_pool_id = "github"
  display_name              = "GitHub Actions"

  depends_on = [google_project_service.ci]
}

resource "google_iam_workload_identity_pool_provider" "github" {
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "github"
  display_name                       = "GitHub OIDC"

  attribute_mapping = {
    "google.subject"        = "assertion.sub"
    "attribute.repository"  = "assertion.repository"
    "attribute.environment" = "assertion.environment"
  }

  attribute_condition = "assertion.repository == '${var.github_repository}' && assertion.environment in ['${local.deploy_environment}', '${local.plan_environment}']"

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

resource "google_service_account" "deployer" {
  account_id   = "github-terraform"
  display_name = "GitHub Actions Terraform deployer"

  depends_on = [google_project_service.ci]
}

resource "google_service_account_iam_member" "deployer_wif" {
  service_account_id = google_service_account.deployer.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.environment/${local.deploy_environment}"
}

resource "google_project_iam_member" "deployer" {
  for_each = var.deployer_roles

  project = var.project_id
  role    = each.value
  member  = google_service_account.deployer.member
}

resource "google_service_account" "planner" {
  account_id   = "github-planner"
  display_name = "GitHub Actions Terraform planner"

  depends_on = [google_project_service.ci]
}

resource "google_service_account_iam_member" "planner_wif" {
  service_account_id = google_service_account.planner.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.environment/${local.plan_environment}"
}

resource "google_project_iam_member" "planner" {
  for_each = var.planner_roles

  project = var.project_id
  role    = each.value
  member  = google_service_account.planner.member
}

