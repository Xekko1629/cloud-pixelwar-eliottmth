locals {
  github_owner = split("/", var.github_repository)[0]
  github_repo  = split("/", var.github_repository)[1]

  github_environments = {
    (local.deploy_environment) = google_service_account.deployer.email
    (local.plan_environment)   = google_service_account.planner.email
  }
}

data "github_user" "deploy_reviewers" {
  for_each = toset(var.deploy_reviewers)

  username = each.value
}

resource "github_repository_environment" "deploy" {
  repository  = local.github_repo
  environment = local.deploy_environment

  dynamic "reviewers" {
    for_each = length(var.deploy_reviewers) > 0 ? [1] : []

    content {
      users = [for user in data.github_user.deploy_reviewers : user.id]
    }
  }

  dynamic "deployment_branch_policy" {
    for_each = length(var.deploy_branch_patterns) + length(var.deploy_tag_patterns) > 0 ? [1] : []

    content {
      protected_branches     = false
      custom_branch_policies = true
    }
  }
}

resource "github_repository_environment_deployment_policy" "branches" {
  for_each = toset(var.deploy_branch_patterns)

  repository     = local.github_repo
  environment    = github_repository_environment.deploy.environment
  branch_pattern = each.value
}

resource "github_repository_environment_deployment_policy" "tags" {
  for_each = toset(var.deploy_tag_patterns)

  repository  = local.github_repo
  environment = github_repository_environment.deploy.environment
  tag_pattern = each.value
}

resource "github_repository_environment" "plan" {
  repository  = local.github_repo
  environment = local.plan_environment
}

resource "github_actions_environment_variable" "wif_provider" {
  for_each = local.github_environments

  repository    = local.github_repo
  environment   = each.key
  variable_name = "WIF_PROVIDER"
  value         = google_iam_workload_identity_pool_provider.github.name

  depends_on = [github_repository_environment.deploy, github_repository_environment.plan]
}

resource "github_actions_environment_variable" "deployer_sa" {
  for_each = local.github_environments

  repository    = local.github_repo
  environment   = each.key
  variable_name = "DEPLOYER_SA"
  value         = each.value

  depends_on = [github_repository_environment.deploy, github_repository_environment.plan]
}
