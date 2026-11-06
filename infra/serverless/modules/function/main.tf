resource "google_service_account" "runtime" {
  project      = var.project_id
  account_id   = var.name
  display_name = "Runtime identity for ${var.name}"
}

# Separate identity used by Pub/Sub to call a worker, not by its application code.
resource "google_service_account" "invoker" {
  count = var.service_type == "worker" ? 1 : 0

  project      = var.project_id
  account_id   = "invoke-${substr(sha256(var.name), 0, 20)}"
  display_name = "Push invoker for ${var.name}"
}

resource "google_project_iam_member" "observability" {
  for_each = toset([
    "roles/logging.logWriter",
    "roles/cloudtrace.agent",
    "roles/monitoring.metricWriter",
    "roles/telemetry.tracesWriter",
  ])

  project = var.project_id
  role    = each.value
  member  = google_service_account.runtime.member
}

resource "google_secret_manager_secret_iam_member" "runtime" {
  for_each = toset([for secret in values(var.secrets) : secret.secret])

  project   = var.project_id
  secret_id = each.value
  role      = "roles/secretmanager.secretAccessor"
  member    = google_service_account.runtime.member
}

resource "google_cloudfunctions2_function" "main" {
  project         = var.project_id
  name            = var.name
  location        = var.region
  labels          = var.labels
  description     = "HTTP function ${var.name}; source SHA-256 ${var.source_archive.sha256}"
  deletion_policy = var.deletion_protection ? "PREVENT" : "DELETE"

  build_config {
    runtime           = "nodejs24"
    entry_point       = var.entry_point
    service_account   = var.build_service_account
    docker_repository = var.build_repository

    source {
      storage_source {
        bucket     = var.source_archive.bucket
        object     = var.source_archive.object
        generation = tonumber(var.source_archive.generation)
      }
    }
  }

  # No event_trigger: HTTP functions invoked by Gateway or explicit Pub/Sub push.
  # Google builds/hosts the image. No application Dockerfile or custom HTTP server.
  service_config {
    service_account_email            = google_service_account.runtime.email
    ingress_settings                 = var.service_type == "proxy" ? "ALLOW_ALL" : "ALLOW_INTERNAL_ONLY"
    min_instance_count               = var.min_instances
    max_instance_count               = var.max_instances
    max_instance_request_concurrency = var.concurrency
    timeout_seconds                  = var.timeout_seconds
    available_cpu                    = var.cpu
    available_memory                 = var.memory
    all_traffic_on_latest_revision   = true
    environment_variables            = var.environment_variables

    dynamic "secret_environment_variables" {
      for_each = var.secrets
      content {
        key        = secret_environment_variables.key
        project_id = var.project_id
        secret     = secret_environment_variables.value.secret
        version    = secret_environment_variables.value.version
      }
    }
  }

  lifecycle {
    precondition {
      condition     = var.min_instances <= var.max_instances
      error_message = "Minimum instances must not exceed maximum instances."
    }
    precondition {
      condition     = length(setintersection(toset(keys(var.environment_variables)), toset(keys(var.secrets)))) == 0
      error_message = "A variable cannot be both a plain environment variable and a secret."
    }
  }

  depends_on = [
    google_project_iam_member.observability,
    google_secret_manager_secret_iam_member.runtime,
  ]
}

# Gen2 HTTP invocation is authorized on the underlying Cloud Run service.
# This IAM resource does not create/manage a second compute service.
resource "google_cloud_run_service_iam_member" "push_invoker" {
  count = var.service_type == "worker" ? 1 : 0

  project  = var.project_id
  location = var.region
  service  = google_cloudfunctions2_function.main.name
  role     = "roles/run.invoker"
  member   = google_service_account.invoker[0].member
}
