locals {
  discord_verify_name         = "discord-command-verify"
  discord_verify_subscription = "projects/${var.project_id}/subscriptions/${local.discord_verify_name}"
}

module "discord_commands" {
  source = "./modules/pubsub-topic"
  count  = local.discord_pipeline_enabled ? 1 : 0

  project_id = var.project_id
  name       = local.discord_command_topic
  labels     = local.labels
  publishers = { discord = module.discord_proxy[0].service_account_member }
}

module "discord_command_dlq" {
  source = "./modules/pubsub-topic"
  count  = local.discord_pipeline_enabled ? 1 : 0

  project_id = var.project_id
  name       = "discord-command-verify-dlq"
  labels     = local.labels
}

module "discord_command_verify_source" {
  source = "./modules/function-source"
  count  = local.discord_pipeline_enabled ? 1 : 0

  name       = local.discord_verify_name
  source_dir = "${path.root}/../../app/dist/functions/discord-command-verify"
  bucket     = local.function_build.sources_bucket
}

module "discord_command_verify" {
  source = "./modules/function"
  count  = local.discord_pipeline_enabled ? 1 : 0

  project_id            = var.project_id
  region                = var.region
  name                  = local.discord_verify_name
  service_type          = "worker"
  source_archive        = module.discord_command_verify_source[0].source_archive
  entry_point           = "handleDiscordCommandVerify"
  build_service_account = local.function_build.service_account
  build_repository      = local.function_build.repository
  labels                = local.labels
  min_instances         = 0
  max_instances         = 2
  timeout_seconds       = 30
  environment_variables = {
    APP_ENV                     = "dev"
    GOOGLE_CLOUD_PROJECT        = var.project_id
    DISCORD_VERIFY_SUBSCRIPTION = local.discord_verify_subscription
  }
  secrets = {
    DISCORD_APPLICATION_ID = { secret = "discord-application-id", version = var.discord_application_id_version }
  }
}

# Ensure the managed Pub/Sub agent exists, without creating a second push invoker.
# The API is enabled by infra/iam. Service identity generation is a future apply action.
resource "google_project_service_identity" "discord_pubsub" {
  provider = google-beta
  count    = local.discord_pipeline_enabled ? 1 : 0

  project = var.project_id
  service = "pubsub.googleapis.com"
}

# Prerequisite: deployer must be allowed to manage this new SA policy (see docs).
# No broad IAM grant is added here to solve that bootstrap requirement.
resource "google_service_account_iam_member" "discord_verify_token_creator" {
  count = local.discord_delivery_enabled ? 1 : 0

  service_account_id = module.discord_command_verify[0].invoker_service_account_name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:${google_project_service_identity.discord_pubsub[0].email}"
}

resource "google_pubsub_topic_iam_member" "discord_verify_dlq_publisher" {
  count = local.discord_delivery_enabled ? 1 : 0

  project = var.project_id
  topic   = module.discord_command_dlq[0].name
  role    = "roles/pubsub.publisher"
  member  = "serviceAccount:${google_project_service_identity.discord_pubsub[0].email}"
}

# Create the DLQ's storage cursor before source delivery can begin.
resource "google_pubsub_subscription" "discord_verify_dlq" {
  count = local.discord_pipeline_enabled ? 1 : 0

  project                    = var.project_id
  name                       = "discord-command-verify-dlq-inspect"
  topic                      = module.discord_command_dlq[0].id
  labels                     = local.labels
  message_retention_duration = "604800s"
  retain_acked_messages      = false
  expiration_policy { ttl = "" }
}

resource "google_pubsub_subscription" "discord_verify" {
  count = local.discord_delivery_enabled ? 1 : 0

  project                    = var.project_id
  name                       = local.discord_verify_name
  topic                      = module.discord_commands[0].id
  labels                     = local.labels
  ack_deadline_seconds       = 30
  message_retention_duration = "604800s"
  retain_acked_messages      = false
  expiration_policy { ttl = "" }

  push_config {
    push_endpoint = module.discord_command_verify[0].uri
    oidc_token {
      service_account_email = module.discord_command_verify[0].invoker_service_account_email
      audience              = module.discord_command_verify[0].uri
    }
  }
  retry_policy {
    minimum_backoff = "10s"
    maximum_backoff = "60s"
  }
  dead_letter_policy {
    dead_letter_topic     = module.discord_command_dlq[0].id
    max_delivery_attempts = 5
  }

  depends_on = [
    google_service_account_iam_member.discord_verify_token_creator,
    google_pubsub_topic_iam_member.discord_verify_dlq_publisher,
    google_pubsub_subscription.discord_verify_dlq,
  ]
}

# Required for forwarding to the DLQ; this is not the worker runtime identity.
resource "google_pubsub_subscription_iam_member" "discord_verify_dlq_forwarder" {
  count = local.discord_delivery_enabled ? 1 : 0

  project      = var.project_id
  subscription = google_pubsub_subscription.discord_verify[0].name
  role         = "roles/pubsub.subscriber"
  member       = "serviceAccount:${google_project_service_identity.discord_pubsub[0].email}"
}
