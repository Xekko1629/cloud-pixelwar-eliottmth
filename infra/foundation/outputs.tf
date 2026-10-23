output "vpc_id" {
  value       = google_compute_network.main.id
  description = "The id of the created VPC network"
}
