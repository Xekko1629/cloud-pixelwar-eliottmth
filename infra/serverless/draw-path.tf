# /draw path (SRV-05): command-worker → pixel-draw → draw-worker → pixel-processed /
# pixel-rejected → discord-notifier, which edits the deferred Discord response.
locals {
  pixel_draw_topic      = "pixel-draw"
  pixel_processed_topic = "pixel-processed"
  pixel_rejected_topic  = "pixel-rejected"

  draw_worker_subscription        = "projects/${var.project_id}/subscriptions/draw-worker"
  notifier_processed_subscription = "projects/${var.project_id}/subscriptions/discord-notifier-processed"
  notifier_rejected_subscription  = "projects/${var.project_id}/subscriptions/discord-notifier-rejected"
}

module "pixel_draw" {
  source = "./modules/pubsub-topic"
  count  = local.discord_pipeline_enabled ? 1 : 0

  project_id = var.project_id
  name       = local.pixel_draw_topic
  labels     = local.labels
  # The web-proxy (DRAW-01) is added with the web path.
  publishers = { command_worker = module.command_worker[0].service_account_member }
}

module "pixel_processed" {
  source = "./modules/pubsub-topic"
  count  = local.discord_pipeline_enabled ? 1 : 0

  project_id = var.project_id
  name       = local.pixel_processed_topic
  labels     = local.labels
  publishers = { draw_worker = module.draw_worker[0].service_account_member }
}

module "pixel_rejected" {
  source = "./modules/pubsub-topic"
  count  = local.discord_pipeline_enabled ? 1 : 0

  project_id = var.project_id
  name       = local.pixel_rejected_topic
  labels     = local.labels
  publishers = { draw_worker = module.draw_worker[0].service_account_member }
}

# DRAW-02: applies each pixel-draw in the DATA-02 transaction, then publishes its result.
module "draw_worker_source" {
  source = "./modules/function-source"
  count  = local.discord_pipeline_enabled ? 1 : 0

  name       = "draw-worker"
  source_dir = "${path.root}/../../app/dist/functions/draw-worker"
  bucket     = local.function_build.sources_bucket
}

# Initial profile from docs/draw-worker.md, to be measured in dev before raising it.
module "draw_worker" {
  source = "./modules/function"
  count  = local.discord_pipeline_enabled ? 1 : 0

  project_id            = var.project_id
  region                = var.region
  name                  = "draw-worker"
  service_type          = "worker"
  source_archive        = module.draw_worker_source[0].source_archive
  entry_point           = "handleDrawWorker"
  build_service_account = local.function_build.service_account
  build_repository      = local.function_build.repository
  labels                = local.labels
  concurrency           = 1
  min_instances         = 0
  max_instances         = 2
  timeout_seconds       = 300
  environment_variables = {
    APP_ENV                 = var.environment
    GOOGLE_CLOUD_PROJECT    = var.project_id
    PIXEL_DRAW_SUBSCRIPTION = local.draw_worker_subscription
    PIXEL_PROCESSED_TOPIC   = local.pixel_processed_topic
    PIXEL_REJECTED_TOPIC    = local.pixel_rejected_topic
  }
  secrets = {
    DISCORD_APPLICATION_ID = { secret = "discord-application-id", version = var.discord_application_id_version }
  }
}

# Reads and writes tiles, users, results and config/global in its transaction.
resource "google_project_iam_member" "draw_worker_firestore" {
  count = local.discord_pipeline_enabled ? 1 : 0

  project = var.project_id
  role    = "roles/datastore.user"
  member  = module.draw_worker[0].service_account_member
}

# BOT-05: edits the deferred Discord response (PATCH @original) with the result.
module "discord_notifier_source" {
  source = "./modules/function-source"
  count  = local.discord_pipeline_enabled ? 1 : 0

  name       = "discord-notifier"
  source_dir = "${path.root}/../../app/dist/functions/discord-notifier"
  bucket     = local.function_build.sources_bucket
}

module "discord_notifier" {
  source = "./modules/function"
  count  = local.discord_pipeline_enabled ? 1 : 0

  project_id            = var.project_id
  region                = var.region
  name                  = "discord-notifier"
  service_type          = "worker"
  source_archive        = module.discord_notifier_source[0].source_archive
  entry_point           = "handleDiscordNotifier"
  build_service_account = local.function_build.service_account
  build_repository      = local.function_build.repository
  labels                = local.labels
  min_instances         = 0
  max_instances         = 2
  timeout_seconds       = 30
  environment_variables = {
    APP_ENV                        = var.environment
    GOOGLE_CLOUD_PROJECT           = var.project_id
    DISCORD_PROCESSED_SUBSCRIPTION = local.notifier_processed_subscription
    DISCORD_REJECTED_SUBSCRIPTION  = local.notifier_rejected_subscription
    # Refusals of /admin by the command-worker (admin-path.tf).
    DISCORD_COMMAND_REJECTED_SUBSCRIPTION = local.notifier_command_rejected_subscription
  }
  secrets = {
    DISCORD_APPLICATION_ID = { secret = "discord-application-id", version = var.discord_application_id_version }
  }
}

# Ack deadlines exceed each worker timeout (ADR-0002); 330 s is the draw-worker margin
# documented in docs/draw-worker.md.
module "draw_worker_subscription" {
  source = "./modules/push-subscription"
  count  = local.discord_delivery_enabled ? 1 : 0

  project_id                    = var.project_id
  name                          = "draw-worker"
  topic_id                      = module.pixel_draw[0].id
  push_endpoint                 = module.draw_worker[0].uri
  invoker_service_account_email = module.draw_worker[0].invoker_service_account_email
  pubsub_agent_member           = local.pubsub_agent_member
  ack_deadline_seconds          = 330
  labels                        = local.labels

  depends_on = [google_service_account_iam_member.push_token_creator]
}

# Web results are acknowledged without action by the notifier (docs/events.md, 7.1).
module "notifier_processed_subscription" {
  source = "./modules/push-subscription"
  count  = local.discord_delivery_enabled ? 1 : 0

  project_id                    = var.project_id
  name                          = "discord-notifier-processed"
  topic_id                      = module.pixel_processed[0].id
  push_endpoint                 = module.discord_notifier[0].uri
  invoker_service_account_email = module.discord_notifier[0].invoker_service_account_email
  pubsub_agent_member           = local.pubsub_agent_member
  ack_deadline_seconds          = 60
  labels                        = local.labels

  depends_on = [google_service_account_iam_member.push_token_creator]
}

module "notifier_rejected_subscription" {
  source = "./modules/push-subscription"
  count  = local.discord_delivery_enabled ? 1 : 0

  project_id                    = var.project_id
  name                          = "discord-notifier-rejected"
  topic_id                      = module.pixel_rejected[0].id
  push_endpoint                 = module.discord_notifier[0].uri
  invoker_service_account_email = module.discord_notifier[0].invoker_service_account_email
  pubsub_agent_member           = local.pubsub_agent_member
  ack_deadline_seconds          = 60
  labels                        = local.labels

  depends_on = [google_service_account_iam_member.push_token_creator]
}
