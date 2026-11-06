output "name" {
  description = "Cloud Run service name for resource-scoped IAM grants"
  value       = google_cloud_run_v2_service.main.name
}

output "uri" {
  description = "Authenticated Cloud Run endpoint"
  value       = google_cloud_run_v2_service.main.uri
}

output "service_account_email" {
  description = "Dedicated runtime identity"
  value       = google_service_account.runtime.email
}

output "service_account_member" {
  description = "IAM member for topic, bucket and other resource-scoped grants"
  value       = google_service_account.runtime.member
}

output "invoker_service_account_email" {
  description = "Worker push identity for Pub/Sub OIDC configuration; null for proxies"
  value       = var.service_type == "worker" ? google_service_account.invoker[0].email : null
}

output "invoker_service_account_name" {
  description = "Worker push identity resource name for scoped actAs / tokenCreator grants; null for proxies"
  value       = var.service_type == "worker" ? google_service_account.invoker[0].name : null
}
