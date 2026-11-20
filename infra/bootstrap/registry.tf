# Persistent release artefacts (ADR-0008), applied by the CI before serverless and never
# destroyed. The APIs are enabled by infra/iam, which must be applied first.

resource "google_artifact_registry_repository" "containers" {
  project       = var.project_id
  location      = var.region
  repository_id = "pixelwar"
  description   = "Images built internally by Cloud Build for Cloud Run functions"
  format        = "DOCKER"
  labels = {
    environment = var.environment
    managed_by  = "terraform"
  }

  # First inspect the policy results before enabling actual deletions.
  cleanup_policy_dry_run = true

  cleanup_policies {
    id     = "delete-old-images"
    action = "DELETE"
    condition {
      tag_state  = "ANY"
      older_than = "604800s"
    }
  }

  cleanup_policies {
    id     = "keep-recent-images"
    action = "KEEP"
    most_recent_versions {
      keep_count = var.image_versions_to_keep
    }
  }

  lifecycle {
    prevent_destroy = true
  }

}
