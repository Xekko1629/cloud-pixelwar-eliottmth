output "name" {
  description = "Subscription name"
  value       = google_pubsub_subscription.main.name
}

output "path" {
  description = "Full subscription name, as checked by the worker: projects/<project>/subscriptions/<name>"
  value       = "projects/${var.project_id}/subscriptions/${google_pubsub_subscription.main.name}"
}

output "dlq_topic_name" {
  description = "DLQ topic name, for the DLQ alerts"
  value       = google_pubsub_topic.dlq.name
}

output "dlq_inspect_subscription_name" {
  description = "Pull subscription to inspect and replay the DLQ"
  value       = google_pubsub_subscription.dlq_inspect.name
}

output "max_delivery_attempts" {
  description = "Delivery attempts before the DLQ"
  value       = google_pubsub_subscription.main.dead_letter_policy[0].max_delivery_attempts
}
