# Mocks only: no credentials, cloud or remote state.
mock_provider "google" {}

variables {
  project_id                    = "pixelwar-test"
  name                          = "draw-worker"
  topic_id                      = "projects/pixelwar-test/topics/pixel-draw"
  push_endpoint                 = "https://draw-worker-abc-ew.a.run.app"
  invoker_service_account_email = "invoke-draw@pixelwar-test.iam.gserviceaccount.com"
  pubsub_agent_member           = "serviceAccount:service-123@gcp-sa-pubsub.iam.gserviceaccount.com"
  ack_deadline_seconds          = 330
}

run "push_with_its_own_dlq" {
  command = apply

  assert {
    condition = (
      google_pubsub_subscription.main.name == "draw-worker" &&
      google_pubsub_subscription.main.topic == var.topic_id &&
      google_pubsub_topic.dlq.name == "draw-worker-dlq" &&
      google_pubsub_subscription.dlq_inspect.name == "draw-worker-dlq-inspect" &&
      google_pubsub_subscription.dlq_inspect.topic == google_pubsub_topic.dlq.id &&
      output.path == "projects/pixelwar-test/subscriptions/draw-worker"
    )
    error_message = "Names follow docs/events.md 7.1: <subscription>, <subscription>-dlq, <subscription>-dlq-inspect."
  }
  assert {
    condition = (
      google_pubsub_subscription.main.push_config[0].push_endpoint == var.push_endpoint &&
      google_pubsub_subscription.main.push_config[0].oidc_token[0].audience == var.push_endpoint &&
      google_pubsub_subscription.main.push_config[0].oidc_token[0].service_account_email == var.invoker_service_account_email
    )
    error_message = "Push must target the worker URI with an explicit audience and the dedicated invoker."
  }
  assert {
    condition = (
      google_pubsub_subscription.main.ack_deadline_seconds == 330 &&
      google_pubsub_subscription.main.retry_policy[0].minimum_backoff == "10s" &&
      google_pubsub_subscription.main.retry_policy[0].maximum_backoff == "60s" &&
      google_pubsub_subscription.main.dead_letter_policy[0].max_delivery_attempts == 5 &&
      google_pubsub_subscription.main.dead_letter_policy[0].dead_letter_topic == google_pubsub_topic.dlq.id &&
      google_pubsub_subscription.main.message_retention_duration == "604800s" &&
      google_pubsub_subscription.dlq_inspect.message_retention_duration == "604800s" &&
      !google_pubsub_subscription.main.retain_acked_messages &&
      google_pubsub_subscription.main.expiration_policy[0].ttl == "" &&
      google_pubsub_subscription.dlq_inspect.expiration_policy[0].ttl == ""
    )
    error_message = "Use 10-60 s retries, an approximate 5-attempt DLQ and 7-day retention without idle expiration."
  }
  assert {
    condition = (
      google_pubsub_topic_iam_member.dlq_publisher.topic == google_pubsub_topic.dlq.name &&
      google_pubsub_topic_iam_member.dlq_publisher.role == "roles/pubsub.publisher" &&
      google_pubsub_topic_iam_member.dlq_publisher.member == var.pubsub_agent_member &&
      google_pubsub_subscription_iam_member.dlq_forwarder.subscription == google_pubsub_subscription.main.name &&
      google_pubsub_subscription_iam_member.dlq_forwarder.role == "roles/pubsub.subscriber" &&
      google_pubsub_subscription_iam_member.dlq_forwarder.member == var.pubsub_agent_member
    )
    error_message = "Only the Pub/Sub agent gets the two forwarding rights, scoped to this DLQ and this subscription."
  }
}

run "more_attempts_for_a_bursty_worker" {
  command = plan
  variables { max_delivery_attempts = 10 }

  assert {
    condition     = google_pubsub_subscription.main.dead_letter_policy[0].max_delivery_attempts == 10
    error_message = "A worker saturated by bursts may keep a message longer before its DLQ."
  }
}

run "reject_attempts_outside_pubsub_range" {
  command = plan
  variables { max_delivery_attempts = 4 }
  expect_failures = [var.max_delivery_attempts]
}

run "reject_fractional_attempts" {
  command = plan
  variables { max_delivery_attempts = 7.5 }
  expect_failures = [var.max_delivery_attempts]
}

run "reject_ack_deadline_above_push_maximum" {
  command = plan
  variables { ack_deadline_seconds = 601 }
  expect_failures = [var.ack_deadline_seconds]
}

run "reject_plain_http_endpoint" {
  command = plan
  variables { push_endpoint = "http://draw-worker" }
  expect_failures = [var.push_endpoint]
}

run "reject_reserved_prefix" {
  command = plan
  variables { name = "google-worker" }
  expect_failures = [var.name]
}
