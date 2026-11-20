# Frontend: React application served by an nginx image on Cloud Run (ADR-0011).
# Separate state, applied after infra/gateway whose URL it needs (same idea as ADR-0010).
locals {
  labels = {
    project     = "pixelwar"
    environment = var.environment
    managed_by  = "terraform"
  }

  # null while the gateway publishes no proxy (prd today): the page then says the API is not published.
  gateway_url = try(data.terraform_remote_state.gateway.outputs.gateway_url, null)

  image_repository = "${var.region}-docker.pkg.dev/${var.project_id}/pixelwar/frontend"
  deployed         = var.image != null
}

data "terraform_remote_state" "gateway" {
  backend = "gcs"
  config = {
    bucket = var.state_bucket
    prefix = "gateway"
  }

  # Gateway applied without any published proxy: no gateway_url yet.
  defaults = {
    gateway_url = null
  }
}

# Own identity, without any role: the frontend reads no data, secret nor bucket.
resource "google_service_account" "frontend" {
  project      = var.project_id
  account_id   = "frontend"
  display_name = "Frontend (nginx on Cloud Run), no role"
}

resource "google_cloud_run_v2_service" "frontend" {
  count = local.deployed ? 1 : 0

  project             = var.project_id
  name                = "frontend"
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_ALL"
  deletion_protection = false

  template {
    service_account                  = google_service_account.frontend.email
    max_instance_request_concurrency = 80
    timeout                          = "10s"

    scaling {
      min_instance_count = 0
      max_instance_count = var.max_instances
    }

    containers {
      image = var.image

      ports {
        container_port = 8080
      }

      resources {
        limits = {
          cpu    = "1"
          memory = "256Mi"
        }
        cpu_idle = true
      }

      # Public configuration written into /config.js at startup (checked by the image).
      env {
        name  = "APP_ENV"
        value = var.environment
      }
      env {
        name  = "GATEWAY_URL"
        value = local.gateway_url == null ? "" : local.gateway_url
      }
      env {
        name  = "REALTIME_URL"
        value = var.realtime_url
      }
      env {
        name  = "DISCORD_CLIENT_ID"
        value = var.discord_client_id
      }
    }
  }

  lifecycle {
    precondition {
      condition     = startswith(var.image, "${local.image_repository}@sha256:")
      error_message = "The image must come from the pixelwar repository of this project and region."
    }
  }
}

# The only public service of the project with realtime (ADR-0011, ADR-0013): static files
# only, no API. SEC-01 lists this binding as an accepted exception.
resource "google_cloud_run_v2_service_iam_member" "public" {
  count = local.deployed ? 1 : 0

  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.frontend[0].name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

output "frontend_url" {
  description = "Public HTTPS URL of the frontend; null when no image is deployed"
  value       = one(google_cloud_run_v2_service.frontend[*].uri)
}

output "discord_redirect_uri" {
  description = "Redirect URI to register in the Discord application of this environment (WEB-02)"
  value       = local.deployed ? "${google_cloud_run_v2_service.frontend[0].uri}/auth/callback" : null
}

output "image_repository" {
  description = "Repository the CI pushes the frontend image to"
  value       = local.image_repository
}
