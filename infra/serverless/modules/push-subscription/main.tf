# One push subscription with its own DLQ (ADR-0002, SRV-05): DLQ topic, inspection
# subscription, forwarding rights of the Pub/Sub agent, then the push subscription.
# The agent's tokenCreator on the invoker stays with the caller: several
# subscriptions of one worker share the same invoker and must not manage the
# same binding twice.
locals {
  retention = "604800s" # 7 days of unacknowledged messages
}

resource "google_pubsub_topic" "dlq" {
  project = var.project_id
  name    = "${var.name}-dlq"
  labels  = var.labels
}

resource "google_pubsub_topic_iam_member" "dlq_publisher" {
  project = var.project_id
  topic   = google_pubsub_topic.dlq.name
  role    = "roles/pubsub.publisher"
  member  = var.pubsub_agent_member
}

# Created before the source subscription: forwarded messages are kept for inspection
# and replay. It still contains the Discord interaction token, already expired.
resource "google_pubsub_subscription" "dlq_inspect" {
  project                    = var.project_id
  name                       = "${var.name}-dlq-inspect"
  topic                      = google_pubsub_topic.dlq.id
  labels                     = var.labels
  message_retention_duration = local.retention
  retain_acked_messages      = false
  expiration_policy { ttl = "" }
}

resource "google_pubsub_subscription" "main" {
  project                    = var.project_id
  name                       = var.name
  topic                      = var.topic_id
  labels                     = var.labels
  ack_deadline_seconds       = var.ack_deadline_seconds
  message_retention_duration = local.retention
  retain_acked_messages      = false
  expiration_policy { ttl = "" }

  push_config {
    push_endpoint = var.push_endpoint
    oidc_token {
      service_account_email = var.invoker_service_account_email
      audience              = var.push_endpoint
    }
  }
  retry_policy {
    minimum_backoff = "10s"
    maximum_backoff = "60s"
  }
  dead_letter_policy {
    dead_letter_topic     = google_pubsub_topic.dlq.id
    max_delivery_attempts = var.max_delivery_attempts
  }

  depends_on = [
    google_pubsub_topic_iam_member.dlq_publisher,
    google_pubsub_subscription.dlq_inspect,
  ]
}

# Required for forwarding to the DLQ; not the worker runtime identity.
resource "google_pubsub_subscription_iam_member" "dlq_forwarder" {
  project      = var.project_id
  subscription = google_pubsub_subscription.main.name
  role         = "roles/pubsub.subscriber"
  member       = var.pubsub_agent_member
}
