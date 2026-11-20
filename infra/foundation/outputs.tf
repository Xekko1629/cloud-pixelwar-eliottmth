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
