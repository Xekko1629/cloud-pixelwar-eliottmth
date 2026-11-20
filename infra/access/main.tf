locals {
  is_dev = var.project_id == "cloud-pixelwar-dev"

  # Do not expand to OAuth/admin/prod secrets without a separate access review.
  bot02_secret_ids = local.is_dev ? toset(["discord-application-id", "discord-bot-token"]) : toset([])
  developer_emails = toset([for email in var.developer_emails : lower(email)])
  secret_readers = {
    for pair in setproduct(local.bot02_secret_ids, local.developer_emails) :
    "${pair[0]}:${pair[1]}" => { secret_id = pair[0], email = pair[1] }
  }

  # Lowercase so that a case change does not recreate a binding
  editors = toset(concat(
    [for email in var.team_editors : "user:${lower(email)}"],
    ["user:${lower(var.instructor_email)}"],
  ))
}

# Additive grants: never replace a secret's complete policy or role membership.
# These resources neither create secrets nor read their values/versions.
resource "google_secret_manager_secret_iam_member" "bot02_developer" {
  for_each = local.secret_readers

  project   = var.project_id
  secret_id = each.value.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "user:${each.value.email}"
}

# Team and instructor (subject §1.3, §2.1). Additive: the project owner and the
# CI service accounts are left untouched.
resource "google_project_iam_member" "editor" {
  for_each = local.editors

  project = var.project_id
  role    = "roles/editor"
  member  = each.value
}

# The billing account is shared by both projects: only prd manages it.
resource "google_billing_account_iam_member" "instructor_viewer" {
  count = var.billing_account == "" ? 0 : 1

  billing_account_id = var.billing_account
  role               = "roles/billing.viewer"
  member             = "user:${lower(var.instructor_email)}"
}
