# /get path (BOT-06): command-worker → render-requested → render-worker, which reads
# config/global and the tiles of the current canvas version, renders the painted area
# (DATA-05b) and attaches the PNG to the deferred answer. Same dev flags as /draw.
locals {
  render_requested_topic     = "render-requested"
  render_worker_subscription = "projects/${var.project_id}/subscriptions/render-worker"
}

module "render_requested" {
  source = "./modules/pubsub-topic"
  count  = local.discord_pipeline_enabled ? 1 : 0

  project_id = var.project_id
  name       = local.render_requested_topic
  labels     = local.labels
  publishers = { command_worker = module.command_worker[0].service_account_member }
}

module "render_worker_source" {
  source = "./modules/function-source"
  count  = local.discord_pipeline_enabled ? 1 : 0

  name       = "render-worker"
  source_dir = "${path.root}/../../app/dist/functions/render-worker"
  bucket     = local.function_build.sources_bucket
}

module "render_worker" {
  source = "./modules/function"
  count  = local.discord_pipeline_enabled ? 1 : 0

  project_id            = var.project_id
  region                = var.region
  name                  = "render-worker"
  service_type          = "worker"
  source_archive        = module.render_worker_source[0].source_archive
  entry_point           = "handleRenderWorker"
  build_service_account = local.function_build.service_account
  build_repository      = local.function_build.repository
  labels                = local.labels
  min_instances         = 0
  max_instances         = 2
  # One render per instance: a 2048 × 2048 image (4 MiB of indices), its halvings and the
  # PNG, plus up to 65 536 tiles of 4 KiB streamed from Firestore (GET_RENDER_OPTIONS).
  concurrency = 1
  memory      = "1Gi"
  # Reading the largest allowed area takes tens of seconds; 300 s keeps a margin below the
  # 15-minute token, with an acknowledgement deadline of 330 s.
  timeout_seconds = 300
  environment_variables = {
    APP_ENV                       = var.environment
    GOOGLE_CLOUD_PROJECT          = var.project_id
    RENDER_REQUESTED_SUBSCRIPTION = local.render_worker_subscription
  }
  secrets = {
    DISCORD_APPLICATION_ID = { secret = "discord-application-id", version = var.discord_application_id_version }
  }
}

# Reads config/global and tile_colors only.
resource "google_project_iam_member" "render_worker_firestore" {
  count = local.discord_pipeline_enabled ? 1 : 0

  project = var.project_id
  role    = "roles/datastore.viewer"
  member  = module.render_worker[0].service_account_member
}

module "render_worker_subscription" {
  source = "./modules/push-subscription"
  count  = local.discord_delivery_enabled ? 1 : 0

  project_id                    = var.project_id
  name                          = "render-worker"
  topic_id                      = module.render_requested[0].id
  push_endpoint                 = module.render_worker[0].uri
  invoker_service_account_email = module.render_worker[0].invoker_service_account_email
  pubsub_agent_member           = local.pubsub_agent_member
  ack_deadline_seconds          = 330
  labels                        = local.labels

  depends_on = [google_service_account_iam_member.push_token_creator]
}
