# All applies below use mocks exclusively: no credentials, cloud or remote state.
mock_provider "google" {
  mock_resource "google_storage_bucket_object" {
    defaults = { generation = 1 }
  }
  mock_resource "google_cloudfunctions2_function" {
    defaults = { service_config = { uri = "https://function-test-ew.a.run.app" } }
  }
  mock_resource "google_service_account" {
    defaults = {
      email  = "test-runtime@pixelwar-test.iam.gserviceaccount.com"
      member = "serviceAccount:test-runtime@pixelwar-test.iam.gserviceaccount.com"
      name   = "projects/pixelwar-test/serviceAccounts/test-runtime@pixelwar-test.iam.gserviceaccount.com"
    }
  }
  mock_data "google_project" {
    defaults = { number = "123456789" }
  }
}
mock_provider "google-beta" {
  mock_resource "google_project_service_identity" {
    defaults = { email = "service-123456789@gcp-sa-pubsub.iam.gserviceaccount.com" }
  }
}
mock_provider "archive" {
  mock_data "archive_file" {
    defaults = { output_sha256 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }
  }
}

override_resource {
  target = module.tile_reader[0].google_service_account.runtime
  values = {
    email  = "tile-reader@pixelwar-test.iam.gserviceaccount.com"
    member = "serviceAccount:tile-reader@pixelwar-test.iam.gserviceaccount.com"
    name   = "projects/pixelwar-test/serviceAccounts/tile-reader@pixelwar-test.iam.gserviceaccount.com"
  }
}

variables {
  project_id              = "pixelwar-test"
  environment             = "dev"
  enable_discord_pipeline = true
  enable_discord_delivery = true
}

run "disabled_by_default" {
  command = plan

  assert {
    condition = (
      length(module.web_proxy) == 0 && length(module.tile_reader) == 0 &&
      length(google_project_iam_member.tile_reader_firestore) == 0 &&
      !contains(keys(output.gateway_contract.backends), "api") &&
      !contains(keys(output.gateway_contract.backends), "tiles")
    )
    error_message = "No web function and no web backend without opt-in."
  }
}

run "web_api_exports_two_proxies" {
  command = apply
  variables { enable_web_api = true }

  assert {
    condition = (
      module.web_proxy[0].service_type == "proxy" && module.tile_reader[0].service_type == "proxy" &&
      module.web_proxy[0].invoker_service_account_email == null &&
      output.gateway_contract.backends.api.function_name == "web-proxy" &&
      output.gateway_contract.backends.tiles.function_name == "tile-reader" &&
      output.gateway_contract.backends.api.uri == module.web_proxy[0].uri
    )
    error_message = "The gateway gets backend api (web-proxy) and tiles (tile-reader), both private proxies without push invoker."
  }
  assert {
    condition = (
      google_project_iam_member.tile_reader_firestore[0].role == "roles/datastore.viewer" &&
      google_project_iam_member.tile_reader_firestore[0].member == "serviceAccount:tile-reader@pixelwar-test.iam.gserviceaccount.com"
    )
    error_message = "The tile-reader only reads Firestore."
  }
  assert {
    condition     = local.frontend_origin == "https://frontend-123456789.europe-west1.run.app"
    error_message = "Both proxies allow the deterministic frontend origin only (CORS)."
  }
}

run "never_in_prd" {
  command = plan
  variables {
    environment    = "prd"
    enable_web_api = true
  }
  assert {
    condition     = length(module.web_proxy) == 0 && length(module.tile_reader) == 0
    error_message = "The web path depends on the dev-only /draw pipeline for now."
  }
}

run "refuse_web_api_without_delivery" {
  command = plan
  variables {
    enable_discord_delivery = false
    enable_web_api          = true
  }
  expect_failures = [output.gateway_contract]
}
