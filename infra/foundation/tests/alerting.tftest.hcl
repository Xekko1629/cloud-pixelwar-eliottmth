mock_provider "google" {}

variables {
  project_id         = "pixelwar-test"
  environment        = "dev"
  vpc_cluster_name   = "pixelwar-test-vpc"
  cidr_cluster_block = "10.0.1.0/24"
  alert_emails       = ["alice@example.com", "bob@example.com"]
}

run "one_email_channel_per_address" {
  command = apply

  assert {
    condition = (
      length(google_monitoring_notification_channel.email) == 2 &&
      alltrue([for email, channel in google_monitoring_notification_channel.email :
      channel.type == "email" && channel.labels.email_address == email])
    )
    error_message = "Each address gets its own email channel."
  }

  assert {
    condition     = length(output.alert_notification_channels) == 2
    error_message = "Expose every channel for the alert policies of the other stacks (OBS-04)."
  }
}

run "test_alert_reaches_every_channel" {
  command = apply

  assert {
    condition = (
      google_monitoring_alert_policy.channel_test.conditions[0].condition_matched_log[0].filter ==
      "logName=\"projects/pixelwar-test/logs/pixelwar-alert-test\"" &&
      length(google_monitoring_alert_policy.channel_test.alert_strategy[0].notification_rate_limit) == 1
    )
    error_message = "The test alert fires on an entry of the test log, with the rate limit a log condition needs."
  }

  assert {
    condition = (
      toset(google_monitoring_alert_policy.channel_test.notification_channels) ==
      toset([for channel in google_monitoring_notification_channel.email : channel.name])
    )
    error_message = "The test alert goes to every channel."
  }
}

run "rejects_an_invalid_address" {
  command = plan

  variables {
    alert_emails = ["not-an-email"]
  }

  expect_failures = [var.alert_emails]
}

run "needs_at_least_one_address" {
  command = plan

  variables {
    alert_emails = []
  }

  expect_failures = [var.alert_emails]
}
