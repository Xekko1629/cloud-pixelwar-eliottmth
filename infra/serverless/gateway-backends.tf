# Export deployed proxies, not Gateway resources: the separate gateway state
# consumes this contract only after a successful serverless apply (ADR-0010).
locals {
  gateway_backends = local.discord_hello_enabled ? {
    discord = {
      function_name = module.discord_hello[0].name
      uri           = module.discord_hello[0].uri
      service_type  = module.discord_hello[0].service_type
    }
  } : {}
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
