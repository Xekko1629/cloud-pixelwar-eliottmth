locals {
  # Only routes whose proxy is deployed: API Gateway rejects a backend without an address.
  published_routes = [for route in var.routes : route if contains(keys(var.backends), route.backend)]

  # Backends actually referenced by a route: the gateway gets run.invoker on these only.
  routed_backends = { for key, backend in var.backends : key => backend if contains([for route in local.published_routes : route.backend], key) }

  # OPTIONS preflight of the browser routes: sent without credentials, so never behind
  # security, and answered by the backend that serves the path (it sets the CORS headers).
  preflight_routes = [
    for path in distinct([for route in local.published_routes : route.path if route.cors]) : {
      path             = path
      method           = "options"
      operation_id     = "${[for route in local.published_routes : route.operation_id if route.path == path][0]}Preflight"
      summary          = "CORS preflight, answered by the backend"
      deadline_seconds = 15
      auth             = "none"
      address          = var.backends[[for route in local.published_routes : route.backend if route.path == path][0]].uri
    }
  ]

  operations = concat(
    [for route in local.published_routes : {
      path             = route.path
      method           = route.method
      operation_id     = route.operation_id
      summary          = route.summary
      deadline_seconds = route.deadline_seconds
      auth             = route.auth
      address          = var.backends[route.backend].uri
    }],
    local.preflight_routes,
  )

  paths = {
    for path in distinct([for operation in local.operations : operation.path]) :
    path => [for operation in local.operations : operation if operation.path == path]
  }

  openapi = templatefile("${path.module}/openapi.yaml.tftpl", {
    title = var.api_id
    paths = local.paths
    # Firebase ID tokens of this project (ADR-0005): the Firebase project ID is the GCP project ID.
    firebase_project_id = var.project_id
  })
}

# Identity the gateway uses to call the private proxy functions (ID token signed for each backend).
resource "google_service_account" "gateway" {
  project      = var.project_id
  account_id   = "${var.api_id}-gateway"
  display_name = "API Gateway identity for ${var.api_id}"
}

resource "google_api_gateway_api" "main" {
  provider = google-beta

  project      = var.project_id
  api_id       = var.api_id
  display_name = var.api_id
  labels       = var.labels
}

# The managed service created for the API must be enabled in the project to serve traffic.
resource "google_project_service" "managed" {
  project = var.project_id
  service = google_api_gateway_api.main.managed_service

  # Disposable: the managed service disappears with the API.
  disable_on_destroy = true
}

# An API config is immutable: any change in the spec creates a new config (random suffix),
# the gateway switches to it, then the old one is deleted.
resource "google_api_gateway_api_config" "main" {
  provider = google-beta

  project              = var.project_id
  api                  = google_api_gateway_api.main.api_id
  api_config_id_prefix = "${var.api_id}-"
  display_name         = "${var.api_id} (${substr(sha256(local.openapi), 0, 8)})"
  labels               = var.labels

  openapi_documents {
    document {
      path     = "openapi.yaml"
      contents = base64encode(local.openapi)
    }
  }

  gateway_config {
    backend_config {
      google_service_account = google_service_account.gateway.email
    }
  }

  lifecycle {
    create_before_destroy = true

    precondition {
      condition     = length(local.published_routes) > 0
      error_message = "At least one route must have a deployed backend: API Gateway rejects an empty spec."
    }
  }

  depends_on = [google_project_service.managed]
}

resource "google_api_gateway_gateway" "main" {
  provider = google-beta

  project      = var.project_id
  region       = var.region
  gateway_id   = var.api_id
  display_name = var.api_id
  api_config   = google_api_gateway_api_config.main.id
  labels       = var.labels
}

# Proxies keep IAM authentication on: only the gateway identity may invoke them (SRV-04b).
# A gen2 function is served by a Cloud Run service of the same name: HTTP invocation is
# authorized there with run.invoker (same resource as the worker push invoker of module function).
resource "google_cloud_run_service_iam_member" "gateway_invoker" {
  for_each = local.routed_backends

  project  = var.project_id
  location = var.region
  service  = each.value.function_name
  role     = "roles/run.invoker"
  member   = google_service_account.gateway.member
}
