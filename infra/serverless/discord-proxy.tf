# Creation and routing are deliberately separate: rollback must not delete queues.
locals {
  discord_pipeline_enabled = var.environment == "dev" && var.enable_discord_pipeline
  discord_delivery_enabled = local.discord_pipeline_enabled && var.enable_discord_delivery
  discord_proxy_routed     = var.environment == "dev" && var.use_discord_proxy
  discord_command_topic    = "discord-command"
}

module "discord_proxy_source" {
  source = "./modules/function-source"
  count  = local.discord_pipeline_enabled ? 1 : 0

  name = "discord-proxy"
  # Go sources (ADR-0016): Cloud Build compiles them, no build step in the CI.
  source_dir = "${path.root}/../../app/go/discord-proxy"
  bucket     = local.function_build.sources_bucket
}

module "discord_proxy" {
  source = "./modules/function"
  count  = local.discord_pipeline_enabled ? 1 : 0

  project_id            = var.project_id
  region                = var.region
  name                  = "discord-proxy"
  service_type          = "proxy"
  runtime               = "go126"
  source_archive        = module.discord_proxy_source[0].source_archive
  entry_point           = "handleDiscordProxy"
  build_service_account = local.function_build.service_account
  build_repository      = local.function_build.repository
  labels                = local.labels
  # Discord gives 3 s for the deferred answer; a cold start measured 3.03 s in dev
  # (21/11), so one instance always stays warm.
  min_instances = 1
  max_instances = 2
  environment_variables = {
    APP_ENV               = "dev"
    GOOGLE_CLOUD_PROJECT  = var.project_id
    DISCORD_COMMAND_TOPIC = local.discord_command_topic
  }
  secrets = {
    DISCORD_PUBLIC_KEY     = { secret = "discord-public-key", version = var.discord_proxy_public_key_version }
    DISCORD_APPLICATION_ID = { secret = "discord-application-id", version = var.discord_application_id_version }
  }
}

output "discord_proxy_function_uri" {
  description = "Private IAM-protected dev proxy endpoint; not routed until use_discord_proxy is approved"
  value       = one(module.discord_proxy[*].uri)
}
