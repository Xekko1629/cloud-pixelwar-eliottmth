mock_provider "google" {}
mock_provider "google-beta" {}

variables {
  project_id   = "pixelwar-test"
  environment  = "dev"
  state_bucket = "pixelwar-test-tfstate"
}

override_data {
  target = data.terraform_remote_state.serverless
  values = {
    outputs = {
      gateway_contract = {
        schema_version = 1
        project_id     = "pixelwar-test"
        environment    = "dev"
        region         = "europe-west1"
        backends = {
          discord = {
            function_name = "discord-hello"
            uri           = "https://discord-hello.example.run.app"
            service_type  = "proxy"
          }
        }
      }
    }
  }
}

run "signed_dev_route_only" {
  command = plan
  assert {
    condition     = length(module.api_gateway) == 1 && module.api_gateway[0].published_routes == ["POST /discord/interactions (none)", "GET /discord/health (none)"]
    error_message = "Publish only routes with exported backends, with Discord signature auth delegated to its handler."
  }
}

run "warmup_calls_the_public_health_route" {
  command = plan

  override_module {
    target  = module.api_gateway
    outputs = { url = "https://pixelwar-test.ew.gateway.dev", published_routes = [] }
  }

  assert {
    condition = (
      google_cloud_scheduler_job.gateway_warmup[0].schedule == "*/5 * * * *" &&
      google_cloud_scheduler_job.gateway_warmup[0].http_target[0].http_method == "GET" &&
      google_cloud_scheduler_job.gateway_warmup[0].http_target[0].uri == "https://pixelwar-test.ew.gateway.dev/discord/health" &&
      length(google_cloud_scheduler_job.gateway_warmup[0].http_target[0].oidc_token) == 0 &&
      google_cloud_scheduler_job.gateway_warmup[0].retry_config[0].retry_count == 0
    )
    error_message = "Every 5 minutes, one unauthenticated GET on the public health route, without retry."
  }
}

run "warmup_can_be_disabled" {
  command = plan
  variables { warmup_schedule = null }
  assert {
    condition     = length(google_cloud_scheduler_job.gateway_warmup) == 0
    error_message = "warmup_schedule = null disables the warm-up job."
  }
}

run "empty_contract_does_not_create_gateway" {
  command = plan
  override_data {
    target = data.terraform_remote_state.serverless
    values = {
      outputs = {
        gateway_contract = {
          schema_version = 1
          project_id     = "pixelwar-test"
          environment    = "dev"
          region         = "europe-west1"
          backends       = {}
        }
      }
    }
  }
  assert {
    condition     = length(module.api_gateway) == 0 && output.gateway_url == null
    error_message = "An applied contract with no proxies must not create an empty Gateway."
  }
}

run "missing_contract_fails_closed" {
  command = plan
  override_data {
    target = data.terraform_remote_state.serverless
    values = { outputs = {} }
  }
  expect_failures = [data.terraform_remote_state.serverless]
}

run "empty_prd_contract_is_valid" {
  command = plan
  variables {
    project_id   = "pixelwar-prd"
    environment  = "prd"
    state_bucket = "pixelwar-prd-tfstate"
  }
  override_data {
    target = data.terraform_remote_state.serverless
    values = {
      outputs = {
        gateway_contract = {
          schema_version = 1
          project_id     = "pixelwar-prd"
          environment    = "prd"
          region         = "europe-west1"
          backends       = {}
        }
      }
    }
  }
  assert {
    condition     = length(module.api_gateway) == 0
    error_message = "The probe must not publish a Gateway in a prd environment with an empty backend contract."
  }
}

run "wrong_environment_fails_closed" {
  command = plan
  variables { environment = "prd" }
  expect_failures = [data.terraform_remote_state.serverless]
}

run "wrong_project_fails_closed" {
  command = plan
  variables { project_id = "pixelwar-other" }
  expect_failures = [data.terraform_remote_state.serverless]
}

run "wrong_region_fails_closed" {
  command = plan
  variables { region = "us-central1" }
  expect_failures = [data.terraform_remote_state.serverless]
}

run "unsupported_contract_version_fails_closed" {
  command = plan
  override_data {
    target = data.terraform_remote_state.serverless
    values = {
      outputs = {
        gateway_contract = {
          schema_version = 2
          project_id     = "pixelwar-test"
          environment    = "dev"
          region         = "europe-west1"
          backends       = {}
        }
      }
    }
  }
  expect_failures = [data.terraform_remote_state.serverless]
}

run "web_backends_publish_draw_and_reads" {
  command = plan

  override_data {
    target = data.terraform_remote_state.serverless
    values = {
      outputs = {
        gateway_contract = {
          schema_version = 1
          project_id     = "pixelwar-test"
          environment    = "dev"
          region         = "europe-west1"
          backends = {
            api   = { function_name = "web-proxy", uri = "https://web-proxy.example.run.app", service_type = "proxy" }
            tiles = { function_name = "tile-reader", uri = "https://tile-reader.example.run.app", service_type = "proxy" }
          }
        }
      }
    }
  }

  assert {
    condition = toset(module.api_gateway[0].published_routes) == toset([
      "POST /api/pixels (session)",
      "GET /api/regions/{rx}/{ry}/tiles (session)",
      "GET /api/tiles/{tx}/{ty}/meta (session)",
      "GET /api/state (session)",
      "OPTIONS /api/pixels (none)",
      "OPTIONS /api/regions/{rx}/{ry}/tiles (none)",
      "OPTIONS /api/tiles/{tx}/{ty}/meta (none)",
      "OPTIONS /api/state (none)",
    ])
    error_message = "The web backends publish the draw route and the three grid reads behind the session JWT, plus their unauthenticated CORS preflights."
  }
}
