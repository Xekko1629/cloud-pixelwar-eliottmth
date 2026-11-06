locals {
  # Do not expand to OAuth/admin/prod secrets without a separate access review.
  bot02_secret_ids = toset(["discord-application-id", "discord-bot-token"])
  developer_emails = toset([for email in var.developer_emails : lower(email)])
  secret_readers = {
    for pair in setproduct(local.bot02_secret_ids, local.developer_emails) :
    "${pair[0]}:${pair[1]}" => { secret_id = pair[0], email = pair[1] }
  }
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
