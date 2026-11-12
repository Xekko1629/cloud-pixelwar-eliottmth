mock_provider "google" {
  mock_resource "google_storage_bucket_object" {
    defaults = { generation = 1 }
  }
}
mock_provider "google-beta" {}
mock_provider "archive" {
  mock_data "archive_file" {
    defaults = { output_sha256 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }
  }
}

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
    condition     = length(module.discord_hello) == 1 && length(module.api_gateway) == 1
    error_message = "Enabling the dev probe creates its function and gateway."
  }

  assert {
    condition     = module.discord_hello[0].service_type == "proxy" && module.discord_hello[0].name == "discord-hello"
    error_message = "The probe is a named proxy, never a Pub/Sub worker."
  }

  assert {
    condition     = module.api_gateway[0].published_routes == ["POST /discord/interactions (none)"]
    error_message = "Only the signed Discord callback is published, not Firebase hello or future business routes."
  }
}

run "never_enable_probe_in_prd" {
  command = plan

  variables {
    environment          = "prd"
    enable_discord_hello = true
  }

  assert {
    condition     = length(module.discord_hello) == 0 && length(module.discord_hello_source) == 0 && length(module.api_gateway) == 0
    error_message = "Even a mistakenly enabled flag must not deploy the temporary probe or gateway to prd."
  }
}

run "probe_disabled_by_default" {
  command = plan

  assert {
    condition     = length(module.discord_hello) == 0 && length(module.api_gateway) == 0
    error_message = "The temporary probe must be opt-in (enabled explicitly by dev.tfvars)."
  }
}
