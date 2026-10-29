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

resource "google_cloud_run_v2_service" "main" {
  project             = var.project_id
  name                = var.name
  location            = var.region
  labels              = var.labels
  deletion_protection = var.deletion_protection
  # Proxies accept API Gateway over the public network, with IAM authentication.
  # Workers only accept internal sources, including same-project Pub/Sub push.
  ingress              = var.service_type == "proxy" ? "INGRESS_TRAFFIC_ALL" : "INGRESS_TRAFFIC_INTERNAL_ONLY"
  invoker_iam_disabled = false
  default_uri_disabled = false

  template {
    service_account                  = google_service_account.runtime.email
    timeout                          = "${var.timeout_seconds}s"
    max_instance_request_concurrency = var.concurrency

    scaling {
      min_instance_count = var.min_instances
      max_instance_count = var.max_instances
    }

    containers {
      image = var.image

      ports {
        container_port = 8080
      }

      resources {
        limits = {
          cpu    = var.cpu
          memory = var.memory
        }
        cpu_idle          = true
        startup_cpu_boost = true
      }

      dynamic "env" {
        for_each = var.environment_variables
        content {
          name  = env.key
          value = env.value
        }
      }

      dynamic "env" {
        for_each = var.secrets
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = env.value.secret
              version = env.value.version
            }
          }
        }
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

resource "google_cloud_run_v2_service_iam_member" "push_invoker" {
  count = var.service_type == "worker" ? 1 : 0

  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.main.name
  role     = "roles/run.invoker"
  member   = google_service_account.invoker[0].member
}
