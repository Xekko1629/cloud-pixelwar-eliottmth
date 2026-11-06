mock_provider "google" {}

variables {
  project_id  = "pixelwar-test"
  environment = "dev"
}

run "persistent_registry" {
  command = plan

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
}
