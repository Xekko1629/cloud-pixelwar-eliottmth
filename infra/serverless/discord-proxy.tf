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
  # Go sources (ADR-0016): Cloud Build compiles them, no build step in the CI. Only the
  # module files and the non-test sources are delivered (SEC-02): no test, README or
  # local file (binary, .env) left in the directory.
  source_dir = "${path.root}/../../app/go/discord-proxy"
  files = concat(["go.mod", "go.sum"], [
    for file in fileset("${path.root}/../../app/go/discord-proxy", "*.go") : file if !endswith(file, "_test.go")
  ])
  bucket = local.function_build.sources_bucket
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
  # Discord gives 3 s for the deferred answer. The Node proxy took 3.03 s cold in dev
  # (21/11) and needed one warm instance; the Go binary answers in 5 to 11 ms locally
  # (ADR-0016), and the gateway warmer calls /discord/health every 5 minutes. To be
  # confirmed by the first cold request after the deploy; revert to 1 if above 1 s.
  min_instances = 0
  max_instances = 2
  # Discord sends its own checks (PING, bad signature) alongside real commands: with one
  # request per instance, a /draw landed on a cold instance (4.5 s, dev, 21/11 15:56)
  # while the warm one answered a check. The proxy is stateless and network-bound.
  concurrency = 16
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
