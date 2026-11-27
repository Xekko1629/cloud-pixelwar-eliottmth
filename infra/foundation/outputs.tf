output "vpc_id" {
  value       = google_compute_network.main.id
  description = "The id of the created VPC network"
}

output "cluster_name" {
  value       = one(google_container_cluster.main[*].name)
  description = "Name of the GKE cluster of the runners, null where enable_cluster = false"
}

output "cluster_location" {
  value       = one(google_container_cluster.main[*].location)
  description = "Zone of the GKE cluster of the runners, null where enable_cluster = false"
}

output "alert_notification_channels" {
  value       = [for channel in google_monitoring_notification_channel.email : channel.name]
  description = "Notification channels of the alert policies (OBS-04), one per address of var.alert_emails"
}
