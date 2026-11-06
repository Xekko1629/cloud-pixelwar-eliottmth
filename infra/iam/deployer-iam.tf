# Resource-scoped IAM management for the CI deployer. Persistent resources live in
# this stack; the disposable stacks only add bindings on them (secretAccessor for a
# runtime, Workload Identity for External Secrets). These roles are bound on each
# resource, never at project level.
locals {
  deployer_iam_policy_roles = {
    secret = {
      role_id     = "deployerSecretIamPolicy"
      title       = "Deployer secret IAM policy"
      permissions = ["secretmanager.secrets.getIamPolicy", "secretmanager.secrets.setIamPolicy"]
    }
    serviceaccount = {
      role_id     = "deployerServiceAccountIamPolicy"
      title       = "Deployer service account IAM policy"
      permissions = ["iam.serviceAccounts.getIamPolicy", "iam.serviceAccounts.setIamPolicy"]
    }
  }
}

resource "google_project_iam_custom_role" "deployer_iam_policy" {
  for_each = local.deployer_iam_policy_roles

  role_id     = each.value.role_id
  title       = each.value.title
  description = "IAM policy of one resource only; bound per resource, never on the project."
  permissions = each.value.permissions

  depends_on = [google_project_service.apis]
}
