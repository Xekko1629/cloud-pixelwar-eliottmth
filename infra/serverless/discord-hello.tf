# Temporary SRV-09/BOT-03 probe. Never creates a function or route in prd.
locals {
  discord_hello_enabled = var.environment == "dev" && var.enable_discord_hello
}

module "discord_hello_source" {
  source = "./modules/function-source"
  count  = local.discord_hello_enabled ? 1 : 0

  name       = "discord-hello"
  source_dir = "${path.root}/../../app/dist/functions/discord-hello"
  bucket     = local.function_build.sources_bucket
}

module "discord_hello" {
  source = "./modules/function"
  count  = local.discord_hello_enabled ? 1 : 0

  project_id            = var.project_id
  region                = var.region
  name                  = "discord-hello"
  service_type          = "proxy"
  source_archive        = module.discord_hello_source[0].source_archive
  entry_point           = "handleDiscordHello"
  build_service_account = local.function_build.service_account
  build_repository      = local.function_build.repository
  min_instances         = 0
  max_instances         = 2
  environment_variables = { APP_ENV = "dev" }
  secrets = {
    DISCORD_PUBLIC_KEY = { secret = "discord-public-key", version = var.discord_hello_public_key_version }
  }
}

output "discord_hello_function_uri" {
  description = "Dev probe backend; anonymous direct calls must be rejected by IAM"
  value       = one(module.discord_hello[*].uri)
}
