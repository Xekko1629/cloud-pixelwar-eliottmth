mock_provider "google" {}

variables {
  project_id  = "pixelwar-test"
  environment = "dev"
}

run "persistent_serverless_prerequisites" {
  command = plan

  assert {
    condition = alltrue([
      for service in ["cloudfunctions.googleapis.com", "cloudbuild.googleapis.com", "run.googleapis.com", "artifactregistry.googleapis.com", "storage.googleapis.com"] :
      google_project_service.serverless[service].service == service
    ])
    error_message = "Source-deployed Gen2 functions require Functions, Cloud Build, Cloud Run, Artifact Registry and Storage APIs."
  }

  assert {
    condition     = google_artifact_registry_repository.containers.format == "DOCKER" && google_artifact_registry_repository.containers.repository_id == "pixelwar"
    error_message = "The bootstrap must create a Docker registry."
  }

  assert {
    condition     = google_artifact_registry_repository.containers.cleanup_policy_dry_run == true
    error_message = "Cleanup must initially be in dry-run mode to protect deployed releases."
  }

  assert {
    condition     = length(google_artifact_registry_repository.containers.cleanup_policies) == 2
    error_message = "Cleanup needs both an old-image deletion policy and a recent-image retention policy."
  }

  assert {
    condition     = alltrue([for api in google_project_service.serverless : api.disable_on_destroy == false])
    error_message = "Bootstrap destruction must not disable APIs used by other stacks."
  }

  assert {
    condition = alltrue([
      for service in ["logging.googleapis.com", "monitoring.googleapis.com", "cloudtrace.googleapis.com", "telemetry.googleapis.com"] :
      google_project_service.serverless[service].service == service
    ])
    error_message = "Structured logs and OTLP exports require the observability APIs."
  }

  assert {
    condition = (
      google_storage_bucket.function_sources.name == "pixelwar-test-function-sources" &&
      google_storage_bucket.function_sources.public_access_prevention == "enforced" &&
      google_storage_bucket.function_sources.uniform_bucket_level_access == true &&
      google_storage_bucket.function_sources.force_destroy == false
    )
    error_message = "Function sources need a private, persistent bucket that Terraform cannot empty."
  }

  assert {
    condition = (
      google_storage_bucket.function_sources.versioning[0].enabled == true &&
      anytrue([for rule in google_storage_bucket.function_sources.lifecycle_rule : anytrue([for condition in rule.condition : condition.days_since_noncurrent_time == 30])])
    )
    error_message = "Keep noncurrent source generations long enough for the replay horizon, then expire them."
  }

  assert {
    condition = (
      google_service_account.function_builder.account_id == "function-builder" &&
      google_project_iam_member.function_builder_logging.role == "roles/logging.logWriter" &&
      google_storage_bucket_iam_member.function_builder_source_reader.role == "roles/storage.objectViewer" &&
      google_artifact_registry_repository_iam_member.function_builder_writer.role == "roles/artifactregistry.writer"
    )
    error_message = "Google's build needs a dedicated identity with logs, source read and repository write only."
  }

  assert {
    condition = (
      google_storage_bucket_iam_member.function_builder_source_reader.bucket == google_storage_bucket.function_sources.name &&
      google_artifact_registry_repository_iam_member.function_builder_writer.project == var.project_id &&
      google_artifact_registry_repository_iam_member.function_builder_writer.location == var.region
    )
    error_message = "Scope build permissions to the dedicated bucket and repository, not the whole project."
  }
}
