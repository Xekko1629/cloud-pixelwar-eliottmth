resource "google_project_service" "serverless" {
  for_each = toset([
    "artifactregistry.googleapis.com",
    "run.googleapis.com",
    "secretmanager.googleapis.com",
  ])

  project            = var.project_id
  service            = each.value
  disable_on_destroy = false
}

resource "google_artifact_registry_repository" "containers" {
  project       = var.project_id
  location      = var.region
  repository_id = "pixelwar"
  description   = "Container images that survive serverless stack destruction"
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

  depends_on = [google_project_service.serverless]
}
