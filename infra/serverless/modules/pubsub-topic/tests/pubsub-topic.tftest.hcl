mock_provider "google" {}

variables {
  project_id = "pixelwar-test"
  name       = "discord-command"
}

run "topic_without_publishers" {
  command = plan

  assert {
    condition     = google_pubsub_topic.main.project == "pixelwar-test" && output.name == "discord-command"
    error_message = "Create the business topic in the explicit project."
  }
  assert {
    condition     = length(google_pubsub_topic_iam_member.publisher) == 0
    error_message = "An empty publisher map must not grant access implicitly."
  }
}

run "proxy_runtime_publishes_only_to_this_topic" {
  command = plan

  variables {
    publishers = { discord = "serviceAccount:discord-proxy@pixelwar-test.iam.gserviceaccount.com" }
    labels     = { environment = "dev" }
  }

  assert {
    condition = (
      length(google_pubsub_topic_iam_member.publisher) == 1 &&
      google_pubsub_topic_iam_member.publisher["discord"].project == "pixelwar-test" &&
      google_pubsub_topic_iam_member.publisher["discord"].topic == "discord-command" &&
      google_pubsub_topic_iam_member.publisher["discord"].role == "roles/pubsub.publisher" &&
      google_pubsub_topic_iam_member.publisher["discord"].member == "serviceAccount:discord-proxy@pixelwar-test.iam.gserviceaccount.com"
    )
    error_message = "The dedicated runtime must receive only an additive publisher grant scoped to this topic."
  }
  assert {
    condition     = google_pubsub_topic.main.labels.environment == "dev"
    error_message = "Keep environment labels on the topic."
  }
}

run "several_explicit_publishers" {
  command = plan
  variables {
    publishers = {
      discord = "serviceAccount:discord-proxy@pixelwar-test.iam.gserviceaccount.com"
      web     = "serviceAccount:web-proxy@pixelwar-test.iam.gserviceaccount.com"
    }
  }
  assert {
    condition     = toset(keys(google_pubsub_topic_iam_member.publisher)) == toset(["discord", "web"])
    error_message = "Resource keys must use stable logical names, not apply-time computed account emails."
  }
}

run "reject_public" {
  command = plan
  variables { publishers = { discord = "allUsers" } }
  expect_failures = [var.publishers]
}

run "reject_all_authenticated" {
  command = plan
  variables { publishers = { discord = "allAuthenticatedUsers" } }
  expect_failures = [var.publishers]
}

run "reject_human" {
  command = plan
  variables { publishers = { discord = "user:test@example.com" } }
  expect_failures = [var.publishers]
}

run "reject_other_project" {
  command = plan
  variables { publishers = { discord = "serviceAccount:discord-proxy@other-project.iam.gserviceaccount.com" } }
  expect_failures = [var.publishers]
}

run "reject_default_compute" {
  command = plan
  variables { publishers = { discord = "serviceAccount:123456789-compute@developer.gserviceaccount.com" } }
  expect_failures = [var.publishers]
}

run "reject_untyped_email" {
  command = plan
  variables { publishers = { discord = "discord-proxy@pixelwar-test.iam.gserviceaccount.com" } }
  expect_failures = [var.publishers]
}

run "reject_reserved_name" {
  command = plan
  variables { name = "goog-discord-command" }
  expect_failures = [var.name]
}

run "reject_invalid_name" {
  command = plan
  variables { name = "discord/command" }
  expect_failures = [var.name]
}

run "reject_short_name" {
  command = plan
  variables { name = "ab" }
  expect_failures = [var.name]
}
