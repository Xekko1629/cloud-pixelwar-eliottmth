output "repository_id" {
  description = "Artifact Registry repository resource ID"
  value       = google_artifact_registry_repository.containers.id
}

output "repository_url" {
  description = "Docker repository prefix; append /image@sha256:digest"
  value       = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.containers.repository_id}"
}
