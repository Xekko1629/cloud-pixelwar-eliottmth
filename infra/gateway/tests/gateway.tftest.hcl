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
    condition     = length(module.api_gateway) == 1 && module.api_gateway[0].published_routes == ["POST /discord/interactions (none)"]
    error_message = "Publish only routes with exported backends, with Discord signature auth delegated to its handler."
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
