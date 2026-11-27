# Quota of a web request, reserved before its pixels are published (ADR-0017). web-proxy calls
# quota-reserver with an ID token of its own service account; the draw-worker then no longer
# writes users/{uid} for an accepted web pixel. No gateway route: it is not in gateway_contract.
locals {
  quota_reserver_url = "https://quota-reserver-${data.google_project.current.number}.${var.region}.run.app"
}

module "quota_reserver_source" {
  source = "./modules/function-source"
  count  = local.web_api_enabled ? 1 : 0

  name       = "quota-reserver"
  source_dir = "${path.root}/../../app/dist/functions/quota-reserver"
  bucket     = local.function_build.sources_bucket
}

module "quota_reserver" {
  source = "./modules/function"
  count  = local.web_api_enabled ? 1 : 0

  project_id = var.project_id
  region     = var.region
  name       = "quota-reserver"
  # "proxy" only for its ALLOW_ALL ingress: web-proxy has no VPC egress, so an internal
  # ingress would refuse it too. Access is by identity: run.invoker below, nothing else.
  service_type          = "proxy"
  source_archive        = module.quota_reserver_source[0].source_archive
  entry_point           = "handleQuotaReserver"
  build_service_account = local.function_build.service_account
  build_repository      = local.function_build.repository
  labels                = local.labels
  min_instances         = 0
  max_instances         = 3
  # One short transaction per call; the calls of one user serialize on users/{uid} anyway.
  concurrency     = 32
  timeout_seconds = 15
  environment_variables = {
    APP_ENV              = var.environment
    GOOGLE_CLOUD_PROJECT = var.project_id
  }
}

# Reads config/global and ratelimit_overrides, reads and writes users/{uid}.
resource "google_project_iam_member" "quota_reserver_firestore" {
  count = local.web_api_enabled ? 1 : 0

  project = var.project_id
  role    = "roles/datastore.user"
  member  = module.quota_reserver[0].service_account_member
}

# The only caller: any other identity, or none, gets 403 from Cloud Run before the code runs.
resource "google_cloud_run_service_iam_member" "quota_reserver_invoker" {
  count = local.web_api_enabled ? 1 : 0

  project  = var.project_id
  location = var.region
  service  = module.quota_reserver[0].name
  role     = "roles/run.invoker"
  member   = module.web_proxy[0].service_account_member
}
