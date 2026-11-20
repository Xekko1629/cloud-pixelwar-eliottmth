output "repository_id" {
  description = "Artifact Registry repository resource ID"
  value       = google_artifact_registry_repository.containers.id
}

output "repository_name" {
  description = "Artifact Registry repository resource name for the function module build_repository input"
  value       = google_artifact_registry_repository.containers.name
}

output "repository_url" {
  description = "Internal image repository prefix; functions deploy from ZIP sources, not this URL"
  value       = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.containers.repository_id}"
}

output "function_source_bucket" {
  description = "Persistent bucket holding immutable <sha256>.zip function sources"
  value       = google_storage_bucket.function_sources.name
}

output "function_builder_service_account_name" {
  description = "Dedicated build identity resource name for the function module build_service_account input"
  value       = google_service_account.function_builder.name
}

output "function_builder_service_account_email" {
  description = "Dedicated build identity email"
  value       = google_service_account.function_builder.email
}
