# Phase 2, applied by an authorized operator after serverless creates the invoker.
# No identity is created/imported here; serverless retains its ownership.
locals {
  discord_verify_iam_enabled = var.environment == "dev" && var.enable_discord_verify_iam
  # Must match modules/function/main.tf for the fixed diagnostic worker name.
  discord_verify_invoker_id = "invoke-${substr(sha256("discord-command-verify"), 0, 20)}"
}

data "google_service_account" "discord_verify_invoker" {
  count = local.discord_verify_iam_enabled ? 1 : 0

  project    = var.project_id
  account_id = local.discord_verify_invoker_id
}

resource "google_service_account_iam_member" "deployer_manages_discord_verify" {
  count = local.discord_verify_iam_enabled ? 1 : 0

  service_account_id = data.google_service_account.discord_verify_invoker[0].name
  role               = google_project_iam_custom_role.deployer_iam_policy["serviceaccount"].name
  member             = google_service_account.deployer.member
}

# Explicit, scoped actAs even when the deployer's current broad editor role covers it.
resource "google_service_account_iam_member" "deployer_uses_discord_verify" {
  count = local.discord_verify_iam_enabled ? 1 : 0

  service_account_id = data.google_service_account.discord_verify_invoker[0].name
  role               = "roles/iam.serviceAccountUser"
  member             = google_service_account.deployer.member
}

# Defining a project custom role does not grant it project-wide: the binding below
# is attached only to this invoker, and contains no write or impersonation right.
resource "google_project_iam_custom_role" "discord_verify_policy_read" {
  count = local.discord_verify_iam_enabled ? 1 : 0

  project     = var.project_id
  role_id     = "discordVerifyIamPolicyRead"
  title       = "Diagnostic invoker IAM policy read"
  description = "Read only the IAM policy of the diagnostic Discord invoker."
  permissions = ["iam.serviceAccounts.getIamPolicy"]
  depends_on  = [google_project_service.apis]
}

resource "google_service_account_iam_member" "planner_reads_discord_verify" {
  count = local.discord_verify_iam_enabled ? 1 : 0

  service_account_id = data.google_service_account.discord_verify_invoker[0].name
  role               = google_project_iam_custom_role.discord_verify_policy_read[0].name
  member             = google_service_account.planner.member
}
