mock_provider "google" {}

variables {
  project_id = "cloud-pixelwar-dev"
  developer_emails = [
    "benjamin.melinette@gmail.com",
    "Eliott603@gmail.com",
    "zekyro.exe@gmail.com",
  ]
  team_editors = [
    "benjamin.melinette@gmail.com",
    "Zekyro.exe@gmail.com",
  ]
}

run "six_scoped_additive_grants" {
  command = plan

  assert {
    condition     = length(google_secret_manager_secret_iam_member.bot02_developer) == 6
    error_message = "Exactly three developers times two dev secrets must be granted."
  }
  assert {
    condition = alltrue([
      for grant in google_secret_manager_secret_iam_member.bot02_developer :
      grant.project == "cloud-pixelwar-dev" &&
      contains(["discord-bot-token", "discord-application-id"], grant.secret_id) &&
      grant.role == "roles/secretmanager.secretAccessor" &&
      contains([
        "user:benjamin.melinette@gmail.com",
        "user:eliott603@gmail.com",
        "user:zekyro.exe@gmail.com",
      ], grant.member)
    ])
    error_message = "Only the approved user principals and two dev secrets may receive read access."
  }
}

run "dev_team_and_instructor_are_editors" {
  command = plan

  assert {
    condition = toset(keys(google_project_iam_member.editor)) == toset([
      "user:benjamin.melinette@gmail.com",
      "user:zekyro.exe@gmail.com",
      "user:jeremie@jjaouen.com",
    ])
    error_message = "The two team members and the instructor must be editors, with lowercase emails."
  }
  assert {
    condition     = alltrue([for binding in google_project_iam_member.editor : binding.project == "cloud-pixelwar-dev" && binding.role == "roles/editor"])
    error_message = "Project bindings must target the selected project with roles/editor only."
  }
  assert {
    condition     = length(google_billing_account_iam_member.instructor_viewer) == 0
    error_message = "dev must not manage the shared billing account."
  }
}

run "prd_grants_editors_and_billing_viewer_without_secrets" {
  command = plan

  variables {
    project_id      = "cloud-pixelwar-prod"
    billing_account = "0111A1-F02A73-B2E667"
  }

  assert {
    condition     = length(google_secret_manager_secret_iam_member.bot02_developer) == 0
    error_message = "The BOT-02 secret grants are dev only."
  }
  assert {
    condition     = length(google_project_iam_member.editor) == 3 && alltrue([for binding in google_project_iam_member.editor : binding.project == "cloud-pixelwar-prod"])
    error_message = "prd bindings must target the prd project."
  }
  assert {
    condition = (
      length(google_billing_account_iam_member.instructor_viewer) == 1 &&
      google_billing_account_iam_member.instructor_viewer[0].billing_account_id == "0111A1-F02A73-B2E667" &&
      google_billing_account_iam_member.instructor_viewer[0].role == "roles/billing.viewer" &&
      google_billing_account_iam_member.instructor_viewer[0].member == "user:jeremie@jjaouen.com"
    )
    error_message = "The instructor must be billing viewer on the billing account."
  }
}

run "normalize_duplicate_user_emails" {
  command = plan
  variables {
    developer_emails = ["Eliott603@gmail.com", "eliott603@gmail.com"]
    team_editors     = ["Jeremie@jjaouen.com"]
  }
  assert {
    condition     = length(google_secret_manager_secret_iam_member.bot02_developer) == 2 && length(google_project_iam_member.editor) == 1
    error_message = "Email case must not create duplicate IAM resources."
  }
}

run "reject_unknown_project" {
  command = plan
  variables {
    project_id = "some-other-project"
  }
  expect_failures = [var.project_id]
}

run "reject_public_principal" {
  command = plan
  variables {
    developer_emails = ["allUsers"]
  }
  expect_failures = [var.developer_emails]
}

run "reject_service_account_principal_prefix" {
  command = plan
  variables {
    team_editors = ["serviceAccount:deployer@cloud-pixelwar-dev.iam.gserviceaccount.com"]
  }
  expect_failures = [var.team_editors]
}

run "reject_empty_team" {
  command = plan
  variables {
    team_editors = []
  }
  expect_failures = [var.team_editors]
}

run "reject_malformed_billing_account" {
  command = plan
  variables {
    billing_account = "billingAccounts/0111A1-F02A73-B2E667"
  }
  expect_failures = [var.billing_account]
}
