locals {
  labels = {
    project     = "pixelwar"
    environment = var.environment
    managed_by  = "terraform"
  }
  gateway_backends = try(data.terraform_remote_state.serverless.outputs.gateway_contract.backends, {})
}

data "terraform_remote_state" "serverless" {
  backend = "gcs"
  config = {
    bucket = var.state_bucket
    prefix = "serverless"
  }

  lifecycle {
    postcondition {
      condition = try(
        self.outputs.gateway_contract.schema_version == 1 &&
        self.outputs.gateway_contract.project_id == var.project_id &&
        self.outputs.gateway_contract.environment == var.environment &&
        self.outputs.gateway_contract.region == var.region,
        false
      )
      error_message = "Apply serverless successfully first: gateway_contract v1 must match this project, environment and region."
    }
  }
}

# API config create_before_destroy stops at this state's snapshot dependency:
# it cannot propagate into the function resources managed by serverless.
module "api_gateway" {
  source = "../serverless/modules/api-gateway"
  count  = length(local.gateway_backends) > 0 ? 1 : 0

  project_id = var.project_id
  region     = var.region
  routes     = local.gateway_routes
  backends   = local.gateway_backends
}

output "gateway_url" {
  description = "Public HTTPS entry point, null when serverless exports no proxies"
  value       = one(module.api_gateway[*].url)
}

output "gateway_routes" {
  description = "Published routes of the Gateway, null when no proxy is exported"
  value       = one(module.api_gateway[*].published_routes)
}
