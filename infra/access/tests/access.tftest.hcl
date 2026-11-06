mock_provider "google" {}

variables {
  project_id = "cloud-pixelwar-dev"
  developer_emails = [
    "benjamin.melinette@gmail.com",
    "Eliott603@gmail.com",
    "zekyro.exe@gmail.com",
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

run "normalize_duplicate_user_emails" {
  command = plan
  variables {
    developer_emails = ["Eliott603@gmail.com", "eliott603@gmail.com"]
  }
  assert {
    condition     = length(google_secret_manager_secret_iam_member.bot02_developer) == 2
    error_message = "Email case must not create duplicate IAM resources."
  }
}

run "reject_production" {
  command = plan
  variables {
    project_id = "cloud-pixelwar-prod"
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
    developer_emails = ["serviceAccount:deployer@cloud-pixelwar-dev.iam.gserviceaccount.com"]
  }
  expect_failures = [var.developer_emails]
}

run "reject_empty_members" {
  command = plan
  variables {
    developer_emails = []
  }
  expect_failures = [var.developer_emails]
}
