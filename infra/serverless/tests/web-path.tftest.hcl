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
  target = module.web_proxy[0].google_service_account.runtime
  values = {
    email  = "web-proxy@pixelwar-test.iam.gserviceaccount.com"
    member = "serviceAccount:web-proxy@pixelwar-test.iam.gserviceaccount.com"
    name   = "projects/pixelwar-test/serviceAccounts/web-proxy@pixelwar-test.iam.gserviceaccount.com"
  }
}

override_resource {
  target = module.quota_reserver[0].google_service_account.runtime
  values = {
    email  = "quota-reserver@pixelwar-test.iam.gserviceaccount.com"
    member = "serviceAccount:quota-reserver@pixelwar-test.iam.gserviceaccount.com"
    name   = "projects/pixelwar-test/serviceAccounts/quota-reserver@pixelwar-test.iam.gserviceaccount.com"
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
      length(module.quota_reserver) == 0 && length(google_cloud_run_service_iam_member.quota_reserver_invoker) == 0 &&
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
  assert {
    condition = (
      module.quota_reserver[0].name == "quota-reserver" && module.quota_reserver[0].invoker_service_account_email == null &&
      google_cloud_run_service_iam_member.quota_reserver_invoker[0].role == "roles/run.invoker" &&
      google_cloud_run_service_iam_member.quota_reserver_invoker[0].service == "quota-reserver" &&
      google_cloud_run_service_iam_member.quota_reserver_invoker[0].member == "serviceAccount:web-proxy@pixelwar-test.iam.gserviceaccount.com" &&
      google_project_iam_member.quota_reserver_firestore[0].role == "roles/datastore.user" &&
      google_project_iam_member.quota_reserver_firestore[0].member == "serviceAccount:quota-reserver@pixelwar-test.iam.gserviceaccount.com" &&
      module.web_proxy[0].environment_variables.QUOTA_RESERVER_URL == module.quota_reserver[0].uri &&
      !contains([for backend in values(output.gateway_contract.backends) : backend.function_name], "quota-reserver")
    )
    error_message = "ADR-0017: quota-reserver writes Firestore, is invoked by web-proxy only and has no gateway route."
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

run "proxies_serve_concurrent_requests" {
  command = plan
  variables {
    enable_web_api       = true
    enable_auth_proxy    = true
    enable_discord_hello = true
  }
  assert {
    condition = (
      module.discord_proxy[0].concurrency == 16 && module.web_proxy[0].concurrency == 16 &&
      module.tile_reader[0].concurrency == 16 && module.auth_proxy[0].concurrency == 16 &&
      module.draw_worker[0].concurrency == 128 && module.draw_worker[0].max_instances == 5
    )
    error_message = "Stateless proxies serve 16 requests per instance; the draw-worker holds 128 pushes to group them (ADR-0014) and scales to 5 instances by default."
  }
}

run "draw_worker_ceiling_is_a_variable" {
  command = plan
  variables {
    draw_worker_max_instances = 2
  }
  assert {
    condition     = module.draw_worker[0].max_instances == 2
    error_message = "The scaling demonstration changes the draw-worker ceiling through var.draw_worker_max_instances only."
  }
}

run "draw_worker_ceiling_is_bounded" {
  command = plan
  variables {
    draw_worker_max_instances = 11
  }
  expect_failures = [var.draw_worker_max_instances]
}
