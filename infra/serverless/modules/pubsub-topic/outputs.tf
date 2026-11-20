output "name" {
  description = "Topic short name for DISCORD_COMMAND_TOPIC or another publisher configuration"
  value       = google_pubsub_topic.main.name
}

output "id" {
  description = "Fully qualified topic resource ID"
  value       = google_pubsub_topic.main.id
}
