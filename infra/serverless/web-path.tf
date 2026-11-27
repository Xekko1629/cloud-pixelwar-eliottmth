# Web path (DRAW-01, SRV-11): POST /api/pixels publishes one pixel-draw event per pixel,
# GET /api/regions, /api/tiles and /api/state read the grid. Both functions are proxies
# behind the gateway, which validates the session JWT (ADR-0012).
# The draw-worker and pixel-draw topic come from the /draw path (draw-path.tf).
locals {
  web_api_enabled = var.enable_web_api && local.discord_pipeline_enabled
}

module "web_proxy_source" {
  source = "./modules/function-source"
  count  = local.web_api_enabled ? 1 : 0

  name       = "web-proxy"
  source_dir = "${path.root}/../../app/dist/functions/web-proxy"
  bucket     = local.function_build.sources_bucket
}

module "web_proxy" {
  source = "./modules/function"
  count  = local.web_api_enabled ? 1 : 0

  project_id            = var.project_id
  region                = var.region
  name                  = "web-proxy"
  service_type          = "proxy"
  source_archive        = module.web_proxy_source[0].source_archive
  entry_point           = "handleWebProxy"
  build_service_account = local.function_build.service_account
  build_repository      = local.function_build.repository
  labels                = local.labels
  min_instances         = 0
  max_instances         = 3
  # Stateless and network-bound; a browser sends several requests at once (tiles, state,
  # CORS preflights). One instance per request multiplied cold starts.
  concurrency = 16
  # One request publishes up to 500 messages, each bounded to 5 s.
  timeout_seconds = 15
  environment_variables = {
    APP_ENV              = var.environment
    GOOGLE_CLOUD_PROJECT = var.project_id
    PIXEL_DRAW_TOPIC     = local.pixel_draw_topic
    FRONTEND_ORIGIN      = local.frontend_origin
    # ADR-0017: the quota of each request is reserved there before publication.
    QUOTA_RESERVER_URL = module.quota_reserver[0].uri
  }
}

module "tile_reader_source" {
  source = "./modules/function-source"
  count  = local.web_api_enabled ? 1 : 0

  name       = "tile-reader"
  source_dir = "${path.root}/../../app/dist/functions/tile-reader"
  bucket     = local.function_build.sources_bucket
}

module "tile_reader" {
  source = "./modules/function"
  count  = local.web_api_enabled ? 1 : 0

  project_id            = var.project_id
  region                = var.region
  name                  = "tile-reader"
  service_type          = "proxy"
  source_archive        = module.tile_reader_source[0].source_archive
  entry_point           = "handleTileReader"
  build_service_account = local.function_build.service_account
  build_repository      = local.function_build.repository
  labels                = local.labels
  min_instances         = 0
  max_instances         = 3
  # Stateless and network-bound; a browser sends several requests at once (tiles, state,
  # CORS preflights). One instance per request multiplied cold starts.
  concurrency     = 16
  timeout_seconds = 15
  # OVERVIEW_BUCKET enables the signed far-view URLs (overview-path.tf); without it, 503.
  environment_variables = merge({
    APP_ENV              = var.environment
    GOOGLE_CLOUD_PROJECT = var.project_id
    FRONTEND_ORIGIN      = local.frontend_origin
  }, local.overview_enabled ? { OVERVIEW_BUCKET = local.overview_bucket } : {})
}

# Reads only: tiles, metadata, config/global and the caller's users document.
resource "google_project_iam_member" "tile_reader_firestore" {
  count = local.web_api_enabled ? 1 : 0

  project = var.project_id
  role    = "roles/datastore.viewer"
  member  = module.tile_reader[0].service_account_member
}
