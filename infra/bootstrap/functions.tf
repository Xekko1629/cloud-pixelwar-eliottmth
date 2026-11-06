# Source archives are the promoted release artefact (ADR-0008). They survive a
# serverless destroy so the same bytes can be re-applied or rolled back.
resource "google_storage_bucket" "function_sources" {
  project                     = var.project_id
  name                        = "${var.project_id}-function-sources"
  location                    = var.region
  storage_class               = "STANDARD"
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false

  labels = {
    environment = var.environment
    managed_by  = "terraform"
  }

  versioning {
    enabled = true
  }

  # A content-addressed object is never legitimately overwritten. Keeping one
  # month of noncurrent generations still covers the 15-day replay horizon.
  lifecycle_rule {
    condition {
      days_since_noncurrent_time = 30
    }
    action {
      type = "Delete"
    }
  }

}

# Dedicated Cloud Build identity for source-to-image builds. Never the default
# Compute or Cloud Build service account.
resource "google_service_account" "function_builder" {
  project      = var.project_id
  account_id   = "function-builder"
  display_name = "Cloud Run functions build identity"

}

resource "google_project_iam_member" "function_builder_logging" {
  project = var.project_id
  role    = "roles/logging.logWriter"
  member  = google_service_account.function_builder.member
}

resource "google_storage_bucket_iam_member" "function_builder_source_reader" {
  bucket = google_storage_bucket.function_sources.name
  role   = "roles/storage.objectViewer"
  member = google_service_account.function_builder.member
}

resource "google_artifact_registry_repository_iam_member" "function_builder_writer" {
  project    = var.project_id
  location   = google_artifact_registry_repository.containers.location
  repository = google_artifact_registry_repository.containers.name
  role       = "roles/artifactregistry.writer"
  member     = google_service_account.function_builder.member
}
