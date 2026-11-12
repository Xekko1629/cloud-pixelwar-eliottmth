locals {
  # Route catalogue of the single public entry point (subject §3.1, ADR-0005).
  # A route is published once its backend is listed in local.gateway_backends.
  # Auth on the routes (Firebase JWT on /api/*, CORS preflight) comes with SRV-04c.
  gateway_routes = [
    {
      # Discord interactions: public at the gateway, the proxy verifies the Ed25519 signature.
      path         = "/discord/interactions"
      method       = "post"
      backend      = "discord"
      operation_id = "discordInteraction"
      summary      = "Discord slash command or PING (signature verified by discord-proxy)"
      # Discord expects an answer within 3 s; never wait longer for the proxy.
      deadline_seconds = 3
    },
    {
      path         = "/auth/login"
      method       = "get"
      backend      = "auth"
      operation_id = "authLogin"
      summary      = "Discord authorization URL and signed state"
    },
    {
      path         = "/auth/exchange"
      method       = "post"
      backend      = "auth"
      operation_id = "authExchange"
      summary      = "Exchange the Discord code for a Firebase custom token"
    },
    {
      path         = "/api/pixels"
      method       = "post"
      backend      = "api"
      operation_id = "drawPixels"
      summary      = "Draw one pixel or a brush batch (published to Pub/Sub)"
    },
    {
      # Temporary end-to-end check of the C05 checklist (SRV-09, #39).
      path         = "/hello"
      method       = "get"
      backend      = "hello"
      operation_id = "hello"
      summary      = "C05 checklist service, removed once the real proxies are live"
    },
  ]

  # Deployed proxy functions only. Uncomment an entry when its module "function"
  # (service_type = "proxy") exists, e.g. for hello:
  #   hello = { function_name = module.hello.name, uri = module.hello.uri, service_type = module.hello.service_type }
  # Same shape for discord (module.discord_proxy, BOT-03), auth (module.auth_proxy, WEB-02a)
  # and api (module.web_proxy, DRAW-01).
  gateway_backends = {}
}

# Not created until a proxy exists: API Gateway rejects a spec without any backend.
# Labels come from the default_labels of the providers.
module "api_gateway" {
  source = "./modules/api-gateway"
  count  = length(local.gateway_backends) > 0 ? 1 : 0

  project_id = var.project_id
  region     = var.region
  routes     = local.gateway_routes
  backends   = local.gateway_backends
}

output "gateway_url" {
  description = "Public HTTPS entry point (Discord interactions endpoint, frontend API base URL); null until a proxy is deployed"
  value       = one(module.api_gateway[*].url)
}

output "gateway_routes" {
  description = "Routes currently published by the gateway"
  value       = one(module.api_gateway[*].published_routes)
}
