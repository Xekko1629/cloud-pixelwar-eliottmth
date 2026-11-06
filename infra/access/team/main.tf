locals {
  # Lowercase so that a case change does not recreate a binding
  editors = toset(concat(
    [for email in var.team_editors : "user:${lower(email)}"],
    ["user:${lower(var.instructor_email)}"],
  ))
}

# Additive bindings: they never replace the project policy, so the manual owner
# of the project and the CI service accounts are left untouched.
resource "google_project_iam_member" "editor" {
  for_each = local.editors

  project = var.project_id
  role    = "roles/editor"
  member  = each.value
}

# The billing account is shared by both projects: only one environment manages it.
resource "google_billing_account_iam_member" "instructor_viewer" {
  count = var.billing_account == "" ? 0 : 1

  billing_account_id = var.billing_account
  role               = "roles/billing.viewer"
  member             = "user:${lower(var.instructor_email)}"
}
