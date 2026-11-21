# /admin path (BOT-08, DATA-04): command-worker → admin-requested → admin-worker, which
# applies the command in Firestore and answers the admin; command-rejected → notifier
# answers a refused command. Same dev flags as the /draw path.
locals {
  admin_requested_topic  = "admin-requested"
  command_rejected_topic = "command-rejected"

  admin_worker_subscription              = "projects/${var.project_id}/subscriptions/admin-worker"
  notifier_command_rejected_subscription = "projects/${var.project_id}/subscriptions/discord-notifier-command-rejected"
}

module "admin_requested" {
  source = "./modules/pubsub-topic"
  count  = local.discord_pipeline_enabled ? 1 : 0

  project_id = var.project_id
  name       = local.admin_requested_topic
  labels     = local.labels
  publishers = { command_worker = module.command_worker[0].service_account_member }
}

module "command_rejected" {
  source = "./modules/pubsub-topic"
  count  = local.discord_pipeline_enabled ? 1 : 0

  project_id = var.project_id
  name       = local.command_rejected_topic
  labels     = local.labels
  publishers = { command_worker = module.command_worker[0].service_account_member }
}

module "admin_worker_source" {
  source = "./modules/function-source"
  count  = local.discord_pipeline_enabled ? 1 : 0

  name       = "admin-worker"
  source_dir = "${path.root}/../../app/dist/functions/admin-worker"
  bucket     = local.function_build.sources_bucket
}

module "admin_worker" {
  source = "./modules/function"
  count  = local.discord_pipeline_enabled ? 1 : 0

  project_id            = var.project_id
  region                = var.region
  name                  = "admin-worker"
  service_type          = "worker"
  source_archive        = module.admin_worker_source[0].source_archive
  entry_point           = "handleAdminWorker"
  build_service_account = local.function_build.service_account
  build_repository      = local.function_build.repository
  labels                = local.labels
  min_instances         = 0
  max_instances         = 2
  # The purge after /admin clear has a 120 s budget (purge.ts), plus the transaction and
  # the Discord answer: 180 s, and an acknowledgement deadline of 210 s.
  timeout_seconds = 180
  environment_variables = {
    APP_ENV                      = var.environment
    GOOGLE_CLOUD_PROJECT         = var.project_id
    ADMIN_REQUESTED_SUBSCRIPTION = local.admin_worker_subscription
  }
  secrets = {
    DISCORD_APPLICATION_ID  = { secret = "discord-application-id", version = var.discord_application_id_version }
    DISCORD_ADMIN_ALLOWLIST = { secret = "admin-allowlist", version = var.admin_allowlist_version }
  }
}

# Writes config/global, ratelimit_overrides and admin_events; deletes old tiles.
resource "google_project_iam_member" "admin_worker_firestore" {
  count = local.discord_pipeline_enabled ? 1 : 0

  project = var.project_id
  role    = "roles/datastore.user"
  member  = module.admin_worker[0].service_account_member
}

module "admin_worker_subscription" {
  source = "./modules/push-subscription"
  count  = local.discord_delivery_enabled ? 1 : 0

  project_id                    = var.project_id
  name                          = "admin-worker"
  topic_id                      = module.admin_requested[0].id
  push_endpoint                 = module.admin_worker[0].uri
  invoker_service_account_email = module.admin_worker[0].invoker_service_account_email
  pubsub_agent_member           = local.pubsub_agent_member
  ack_deadline_seconds          = 210
  labels                        = local.labels

  depends_on = [google_service_account_iam_member.push_token_creator]
}

module "notifier_command_rejected_subscription" {
  source = "./modules/push-subscription"
  count  = local.discord_delivery_enabled ? 1 : 0

  project_id                    = var.project_id
  name                          = "discord-notifier-command-rejected"
  topic_id                      = module.command_rejected[0].id
  push_endpoint                 = module.discord_notifier[0].uri
  invoker_service_account_email = module.discord_notifier[0].invoker_service_account_email
  pubsub_agent_member           = local.pubsub_agent_member
  ack_deadline_seconds          = 60
  labels                        = local.labels

  depends_on = [google_service_account_iam_member.push_token_creator]
}
