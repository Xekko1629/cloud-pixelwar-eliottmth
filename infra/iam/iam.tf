locals {
  deploy_environment = var.environment
  plan_environment   = "${var.environment}-plan"
}

resource "google_iam_workload_identity_pool" "github" {
  workload_identity_pool_id = "github"
  display_name              = "GitHub Actions"

  depends_on = [google_project_service.apis]
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

  depends_on = [google_project_service.apis]
}

resource "google_service_account_iam_member" "deployer_wif" {
  service_account_id = google_service_account.deployer.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.environment/${local.deploy_environment}"
}

# No roles/editor: one predefined role per kind of resource the CI manages (variables.tf).
# The cluster roles are only granted where the cluster exists (prd).
resource "google_project_iam_member" "deployer" {
  for_each = setunion(var.deployer_roles, var.enable_runners ? var.deployer_cluster_roles : toset([]))

  project = var.project_id
  role    = each.value
  member  = google_service_account.deployer.member
}

# Project IAM is delegated, not handed over: the deployer may only add or remove
# bindings of the roles listed in deployer_grantable_roles. It cannot grant itself
# (or anyone) owner, editor or projectIamAdmin.
resource "google_project_iam_member" "deployer_project_iam" {
  project = var.project_id
  role    = "roles/resourcemanager.projectIamAdmin"
  member  = google_service_account.deployer.member

  condition {
    title       = "grantable-roles-only"
    description = "Only the runtime roles of deployer_grantable_roles"
    expression  = "api.getAttribute('iam.googleapis.com/modifiedGrantsByRole', []).hasOnly(${jsonencode(sort(tolist(var.deployer_grantable_roles)))})"
  }
}

resource "google_service_account" "planner" {
  account_id   = "github-planner"
  display_name = "GitHub Actions Terraform planner"

  depends_on = [google_project_service.apis]
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

