# Function sources are rebuilt per environment (ADR-0009). The bucket survives
# serverless destroy; versioning retains noncurrent/deleted source generations.
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

data "google_project" "current" {
  project_id = var.project_id
}

locals {
  managed_function_source_prefix = "projects/_/buckets/gcf-v2-sources-${data.google_project.current.number}-${var.region}/objects/"
}

# Cloud Functions stages the submitted archive in its own regional bucket before
# Cloud Build reads it. The bucket may not exist during the first bootstrap:
# constrain a project grant to its objects rather than managing Google's bucket
# or allowing reads across every bucket. No uploads bucket or CMEK is used here.
resource "google_project_iam_member" "function_builder_managed_source_reader" {
  project = var.project_id
  role    = "roles/storage.objectViewer"
  member  = google_service_account.function_builder.member

  condition {
    title       = "function-builder-managed-sources"
    description = "Read only Cloud Functions staged source objects in this project and region."
    expression  = "resource.type == \"storage.googleapis.com/Object\" && resource.name.startsWith(${jsonencode(local.managed_function_source_prefix)})"
  }
}

resource "google_artifact_registry_repository_iam_member" "function_builder_writer" {
  project    = var.project_id
  location   = google_artifact_registry_repository.containers.location
  repository = google_artifact_registry_repository.containers.name
  role       = "roles/artifactregistry.writer"
  member     = google_service_account.function_builder.member
}

# PR plans of infra/serverless refresh the uploaded source objects (modules/function-source):
# roles/viewer has no storage.objects.get. Read-only: the planner cannot upload or delete.
resource "google_storage_bucket_iam_member" "planner_source_reader" {
  bucket = google_storage_bucket.function_sources.name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:github-planner@${var.project_id}.iam.gserviceaccount.com"
}
