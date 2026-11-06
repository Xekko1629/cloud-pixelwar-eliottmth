mock_provider "google" {}

variables {
  project_id   = "cloud-pixelwar-dev"
  team_editors = ["benjamin.melinette@gmail.com", "Zekyro.exe@gmail.com"]
}

run "dev_grants_team_and_instructor_editor" {
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
    error_message = "Bindings must target the selected project with roles/editor only."
  }

  assert {
    condition     = length(google_billing_account_iam_member.instructor_viewer) == 0
    error_message = "Without billing_account, the billing account must not be managed."
  }
}

run "prd_also_grants_billing_viewer" {
  command = plan

  variables {
    project_id      = "cloud-pixelwar-prod"
    billing_account = "0111A1-F02A73-B2E667"
  }

  assert {
    condition     = alltrue([for binding in google_project_iam_member.editor : binding.project == "cloud-pixelwar-prod"])
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

run "duplicate_instructor_in_team_is_merged" {
  command = plan

  variables {
    team_editors = ["Jeremie@jjaouen.com"]
  }

  assert {
    condition     = length(google_project_iam_member.editor) == 1
    error_message = "A principal listed twice must give a single binding."
  }
}

run "reject_unknown_project" {
  command = plan

  variables {
    project_id = "some-other-project"
  }

  expect_failures = [var.project_id]
}

run "reject_principal_prefix" {
  command = plan

  variables {
    team_editors = ["allUsers"]
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
