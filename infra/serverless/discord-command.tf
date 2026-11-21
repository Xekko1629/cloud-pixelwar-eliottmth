locals {
  command_worker_name = "command-worker"
  # Deterministic name: the subscription output depends on the worker URI (cycle).
  command_worker_subscription = "projects/${var.project_id}/subscriptions/${local.command_worker_name}"
}

module "discord_commands" {
  source = "./modules/pubsub-topic"
  count  = local.discord_pipeline_enabled ? 1 : 0

  project_id = var.project_id
  name       = local.discord_command_topic
  labels     = local.labels
  publishers = { discord = module.discord_proxy[0].service_account_member }
}

# BOT-04: routes each verified command; /draw becomes a pixel-draw event.
module "command_worker_source" {
  source = "./modules/function-source"
  count  = local.discord_pipeline_enabled ? 1 : 0

  name       = local.command_worker_name
  source_dir = "${path.root}/../../app/dist/functions/command-worker"
  bucket     = local.function_build.sources_bucket
}

module "command_worker" {
  source = "./modules/function"
  count  = local.discord_pipeline_enabled ? 1 : 0

  project_id            = var.project_id
  region                = var.region
  name                  = local.command_worker_name
  service_type          = "worker"
  source_archive        = module.command_worker_source[0].source_archive
  entry_point           = "handleCommandWorker"
  build_service_account = local.function_build.service_account
  build_repository      = local.function_build.repository
  labels                = local.labels
  # Network-bound and stateless: one instance serves several pushes instead of Cloud Run
  # answering 500 "no available instance" during a cold start (measured in dev, 21/11).
  concurrency     = 8
  min_instances   = 0
  max_instances   = 2
  timeout_seconds = 30
  environment_variables = {
    APP_ENV                      = var.environment
    GOOGLE_CLOUD_PROJECT         = var.project_id
    DISCORD_COMMAND_SUBSCRIPTION = local.command_worker_subscription
    PIXEL_DRAW_TOPIC             = local.pixel_draw_topic
    ADMIN_REQUESTED_TOPIC        = local.admin_requested_topic
    COMMAND_REJECTED_TOPIC       = local.command_rejected_topic
    # render-requested and snapshot-requested are added with their workers (BOT-06,
    # BOT-07); the proxy only forwards /draw and /admin.
  }
  secrets = {
    DISCORD_APPLICATION_ID  = { secret = "discord-application-id", version = var.discord_application_id_version }
    DISCORD_ADMIN_ALLOWLIST = { secret = "admin-allowlist", version = var.admin_allowlist_version }
  }
}

# Ensure the managed Pub/Sub agent exists; it signs the push tokens and forwards to DLQs.
resource "google_project_service_identity" "discord_pubsub" {
  provider = google-beta
  count    = local.discord_pipeline_enabled ? 1 : 0

  project = var.project_id
  service = "pubsub.googleapis.com"
}

locals {
  pubsub_agent_member = local.discord_pipeline_enabled ? "serviceAccount:${google_project_service_identity.discord_pubsub[0].email}" : null

  # One tokenCreator per worker invoker, shared by all the subscriptions of that worker.
  push_invokers = local.discord_delivery_enabled ? {
    command_worker   = module.command_worker[0].invoker_service_account_name
    draw_worker      = module.draw_worker[0].invoker_service_account_name
    discord_notifier = module.discord_notifier[0].invoker_service_account_name
    admin_worker     = module.admin_worker[0].invoker_service_account_name
  } : {}
}

# The CI deployer manages service account policies (roles/iam.serviceAccountAdmin, infra/iam).
resource "google_service_account_iam_member" "push_token_creator" {
  for_each = local.push_invokers

  service_account_id = each.value
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = local.pubsub_agent_member
}

module "command_worker_subscription" {
  source = "./modules/push-subscription"
  count  = local.discord_delivery_enabled ? 1 : 0

  project_id                    = var.project_id
  name                          = local.command_worker_name
  topic_id                      = module.discord_commands[0].id
  push_endpoint                 = module.command_worker[0].uri
  invoker_service_account_email = module.command_worker[0].invoker_service_account_email
  pubsub_agent_member           = local.pubsub_agent_member
  ack_deadline_seconds          = 60
  labels                        = local.labels

  depends_on = [google_service_account_iam_member.push_token_creator]
}
