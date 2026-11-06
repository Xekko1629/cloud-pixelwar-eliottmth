# Persistent bootstrap only. Never run this stack from the access workflow itself.
locals {
  dev_access_enabled = var.enable_dev_secret_access ? 1 : 0
  dev_access_accounts = var.enable_dev_secret_access ? {
    plan  = "access-dev-plan"
    apply = "access-dev"
  } : {}
  dev_access_secret_ids = toset(["discord-application-id", "discord-bot-token"])
  dev_access_secret_grants = {
    for pair in setproduct(keys(local.dev_access_accounts), local.dev_access_secret_ids) :
    "${pair[0]}:${pair[1]}" => { account = pair[0], secret_id = pair[1] }
  }
}

resource "google_storage_bucket" "dev_access_state" {
  count = local.dev_access_enabled

  project                     = var.project_id
  name                        = "cloud-pixelwar-eliottmth-dev-access-tfstate"
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false

  versioning {
    enabled = true
  }
  lifecycle_rule {
    action { type = "Delete" }
    condition {
      with_state         = "ARCHIVED"
      age                = 30
      num_newer_versions = 20
    }
  }
  lifecycle {
    prevent_destroy = true
  }
}

resource "google_service_account" "dev_access" {
  for_each = local.dev_access_accounts

  project      = var.project_id
  account_id   = "github-dev-access-${each.key}"
  display_name = "Dev secret IAM ${each.key} only"
  depends_on   = [google_project_service.ci]
}

resource "google_project_iam_custom_role" "dev_access" {
  for_each = local.dev_access_accounts

  project     = var.project_id
  role_id     = each.key == "plan" ? "devSecretAccessPlan" : "devSecretAccessApply"
  title       = "Dev Secret IAM ${each.key}"
  description = "IAM policy operations only; bound on two secrets, never at project level."
  permissions = each.key == "plan" ? ["secretmanager.secrets.getIamPolicy"] : [
    "secretmanager.secrets.getIamPolicy",
    "secretmanager.secrets.setIamPolicy",
  ]
}

resource "google_secret_manager_secret_iam_member" "dev_access" {
  for_each = local.dev_access_secret_grants

  project   = var.project_id
  secret_id = each.value.secret_id
  role      = google_project_iam_custom_role.dev_access[each.value.account].name
  member    = google_service_account.dev_access[each.value.account].member
}

# Separate bucket: neither workflow identity can read/write the iam/foundation/
# serverless states through these grants. Both need backend init/lock permissions.
resource "google_storage_bucket_iam_member" "dev_access_state" {
  for_each = local.dev_access_accounts

  bucket = google_storage_bucket.dev_access_state[0].name
  role   = "roles/storage.objectAdmin"
  member = google_service_account.dev_access[each.key].member
}

resource "google_iam_workload_identity_pool" "dev_access" {
  count = local.dev_access_enabled

  project                   = var.project_id
  workload_identity_pool_id = "github-dev-access"
  display_name              = "Approved dev secret IAM workflow"
  depends_on                = [google_project_service.ci]
}

resource "google_iam_workload_identity_pool_provider" "dev_access" {
  count = local.dev_access_enabled

  project                            = var.project_id
  workload_identity_pool_id          = google_iam_workload_identity_pool.dev_access[0].workload_identity_pool_id
  workload_identity_pool_provider_id = "github"
  attribute_mapping = {
    "google.subject"        = "assertion.sub"
    "attribute.environment" = "assertion.environment"
  }
  attribute_condition = join(" && ", [
    "assertion.repository == '${var.github_repository}'",
    "assertion.repository_id == '${data.github_repository.dev_access[0].repo_id}'",
    "assertion.repository_owner_id == '${data.github_user.dev_access_admin[0].id}'",
    "assertion.ref == 'refs/heads/prod'",
    "assertion.event_name == 'workflow_dispatch'",
    "assertion.workflow_ref == '${var.github_repository}/.github/workflows/access-dev.yml@refs/heads/prod'",
    "assertion.environment in ['access-dev-plan', 'access-dev']",
  ])
  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

resource "google_service_account_iam_member" "dev_access_wif" {
  for_each = local.dev_access_accounts

  service_account_id = google_service_account.dev_access[each.key].name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.dev_access[0].name}/attribute.environment/${each.value}"
}

data "github_user" "dev_access_admin" {
  count    = local.dev_access_enabled
  username = "Xekko1629"
}

data "github_repository" "dev_access" {
  count     = local.dev_access_enabled
  full_name = var.github_repository
}

resource "github_repository_environment" "dev_access" {
  for_each = local.dev_access_accounts

  repository        = local.github_repo
  environment       = each.value
  can_admins_bypass = false
  # Xekko can initiate and approve his own administrative operation.
  prevent_self_review = false

  dynamic "reviewers" {
    for_each = each.key == "apply" ? [1] : []
    content {
      users = [data.github_user.dev_access_admin[0].id]
    }
  }
  deployment_branch_policy {
    protected_branches     = false
    custom_branch_policies = true
  }
}

resource "github_repository_environment_deployment_policy" "dev_access" {
  for_each = local.dev_access_accounts

  repository     = local.github_repo
  environment    = github_repository_environment.dev_access[each.key].environment
  branch_pattern = "prod"
}

resource "github_actions_environment_variable" "dev_access_wif" {
  for_each = local.dev_access_accounts

  repository    = local.github_repo
  environment   = github_repository_environment.dev_access[each.key].environment
  variable_name = "WIF_PROVIDER"
  value         = google_iam_workload_identity_pool_provider.dev_access[0].name
}

resource "github_actions_environment_variable" "dev_access_sa" {
  for_each = local.dev_access_accounts

  repository    = local.github_repo
  environment   = github_repository_environment.dev_access[each.key].environment
  variable_name = "ACCESS_SA"
  value         = google_service_account.dev_access[each.key].email
}
