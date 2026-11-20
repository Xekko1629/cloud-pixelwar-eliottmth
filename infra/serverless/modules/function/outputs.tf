output "name" {
  description = "Function name; kebab-case also matches its underlying Cloud Run service for IAM"
  value       = google_cloudfunctions2_function.main.name
}

output "uri" {
  description = "Authenticated Gen2 HTTP endpoint for Gateway/Pub/Sub and OIDC audience"
  value       = google_cloudfunctions2_function.main.service_config[0].uri
}

output "service_type" {
  description = "proxy or worker; module api-gateway only accepts proxies as backends"
  value       = var.service_type
}

output "function_id" {
  description = "Cloud Functions v2 resource ID, not a standalone Cloud Run service"
  value       = google_cloudfunctions2_function.main.id
}

output "source_archive" {
  description = "Archive identity for release traceability; CI must verify actual bytes before upload"
  value       = var.source_archive
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
