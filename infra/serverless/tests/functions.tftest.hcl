mock_provider "google" {
  mock_resource "google_storage_bucket_object" {
    defaults = { generation = 1 }
  }
}
mock_provider "archive" {
  mock_data "archive_file" {
    defaults = { output_sha256 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }
  }
}
mock_provider "google-beta" {}

variables {
  project_id  = "pixelwar-test"
  environment = "dev"
}

run "bootstrap_build_inputs" {
  command = plan

  assert {
    condition = output.function_build == {
      sources_bucket  = "pixelwar-test-function-sources"
      service_account = "projects/pixelwar-test/serviceAccounts/function-builder@pixelwar-test.iam.gserviceaccount.com"
      repository      = "projects/pixelwar-test/locations/europe-west1/repositories/pixelwar"
    }
    error_message = "Functions use the bootstrap bucket, build identity and repository, never the default accounts."
  }
}

run "dev_probe_routing" {
  command = plan

  variables {
    enable_discord_hello = true
  }

  assert {
    condition     = length(module.discord_hello) == 1 && toset(keys(output.gateway_contract.backends)) == toset(["discord"])
    error_message = "Enabling the dev probe creates its function and exports a single proxy, not a Gateway."
  }

  assert {
    condition     = module.discord_hello[0].service_type == "proxy" && module.discord_hello[0].name == "discord-hello"
    error_message = "The probe is a named proxy, never a Pub/Sub worker."
  }

  assert {
    condition = (
      output.gateway_contract.schema_version == 1 &&
      output.gateway_contract.project_id == "pixelwar-test" &&
      output.gateway_contract.environment == "dev" &&
      output.gateway_contract.region == "europe-west1" &&
      output.gateway_contract.backends.discord.service_type == "proxy"
    )
    error_message = "Gateway consumers must receive a versioned contract identifying the source project/environment/region."
  }
}

run "never_enable_probe_in_prd" {
  command = plan

  variables {
    environment          = "prd"
    enable_discord_hello = true
  }

  assert {
    condition     = length(module.discord_hello) == 0 && length(module.discord_hello_source) == 0 && length(output.gateway_contract.backends) == 0
    error_message = "Even a mistakenly enabled flag must not deploy the temporary probe or gateway to prd."
  }
}

run "probe_disabled_by_default" {
  command = plan

  assert {
    condition     = length(module.discord_hello) == 0 && length(output.gateway_contract.backends) == 0
    error_message = "The temporary probe must be opt-in (enabled explicitly by dev.tfvars)."
  }
}
