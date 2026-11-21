# Export deployed proxies, not Gateway resources: the separate gateway state
# consumes this contract only after a successful serverless apply (ADR-0010).
locals {
  discord_backends = local.discord_proxy_routed && local.discord_pipeline_enabled ? {
    discord = {
      function_name = module.discord_proxy[0].name
      uri           = module.discord_proxy[0].uri
      service_type  = module.discord_proxy[0].service_type
    }
    } : local.discord_hello_enabled ? {
    discord = {
      function_name = module.discord_hello[0].name
      uri           = module.discord_hello[0].uri
      service_type  = module.discord_hello[0].service_type
    }
  } : {}

  # /auth/* and /api/session/refresh (infra/gateway/routes.tf, backend "auth").
  auth_backends = local.auth_proxy_enabled ? {
    auth = {
      function_name = module.auth_proxy[0].name
      uri           = module.auth_proxy[0].uri
      service_type  = module.auth_proxy[0].service_type
    }
  } : {}

  # POST /api/pixels (backend "api") and the grid reads (backend "tiles").
  web_backends = local.web_api_enabled ? {
    api = {
      function_name = module.web_proxy[0].name
      uri           = module.web_proxy[0].uri
      service_type  = module.web_proxy[0].service_type
    }
    tiles = {
      function_name = module.tile_reader[0].name
      uri           = module.tile_reader[0].uri
      service_type  = module.tile_reader[0].service_type
    }
  } : {}

  gateway_backends = merge(local.discord_backends, local.auth_backends, local.web_backends)
}

output "gateway_contract" {
  description = "Versioned, non-secret proxy endpoints consumed by infra/gateway after serverless apply"
  value = {
    schema_version = 1
    project_id     = var.project_id
    environment    = var.environment
    region         = var.region
    backends       = local.gateway_backends
  }

  precondition {
    condition     = !local.discord_proxy_routed || local.discord_delivery_enabled
    error_message = "Create the dev Discord pipeline and enable authenticated delivery before routing Gateway traffic to the proxy."
  }

  precondition {
    condition     = var.environment != "dev" || !var.enable_discord_delivery || local.discord_pipeline_enabled
    error_message = "Create the dev Discord pipeline before enabling delivery."
  }

  precondition {
    condition     = !var.enable_web_api || var.environment != "dev" || local.discord_delivery_enabled
    error_message = "The web API publishes to pixel-draw: enable the dev pipeline and its delivery first."
  }
}

# For installations that already own a Gateway in this state, ownership must be
# transferred with reviewed removed/import plans, never destroyed implicitly.
# The deployment guard stops those installations before this migration is applied.
removed {
  from = module.api_gateway
  lifecycle {
    destroy = false
  }
}
