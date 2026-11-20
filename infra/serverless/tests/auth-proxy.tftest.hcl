mock_provider "google" {
  mock_resource "google_storage_bucket_object" {
    defaults = { generation = 1 }
  }
  mock_resource "google_service_account" {
    defaults = {
      email  = "session-signer@pixelwar-test.iam.gserviceaccount.com"
      name   = "projects/pixelwar-test/serviceAccounts/session-signer@pixelwar-test.iam.gserviceaccount.com"
      member = "serviceAccount:runtime@pixelwar-test.iam.gserviceaccount.com"
    }
  }
  mock_data "google_project" {
    defaults = { number = "123456789012" }
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

run "disabled_by_default" {
  command = plan

  assert {
    condition = (
      length(module.auth_proxy) == 0 &&
      length(google_service_account_iam_member.auth_proxy_signs_sessions) == 0 &&
      !contains(keys(output.gateway_contract.backends), "auth")
    )
    error_message = "Without enable_auth_proxy, no function, no signing right and no gateway backend."
  }
}

run "auth_proxy_enabled" {
  command = apply

  variables {
    enable_auth_proxy = true
  }

  assert {
    condition = (
      module.auth_proxy[0].name == "auth-proxy" &&
      module.auth_proxy[0].service_type == "proxy" &&
      output.gateway_contract.backends["auth"].function_name == "auth-proxy"
    )
    error_message = "The auth-proxy is a proxy published to the gateway as backend auth."
  }

  assert {
    condition = (
      google_service_account_iam_member.auth_proxy_signs_sessions[0].role == "roles/iam.serviceAccountTokenCreator" &&
      google_service_account_iam_member.auth_proxy_signs_sessions[0].service_account_id == google_service_account.session_signer.name &&
      google_service_account_iam_member.auth_proxy_signs_sessions[0].member == module.auth_proxy[0].service_account_member
    )
    error_message = "Token creator on session-signer only, for the auth-proxy runtime identity only."
  }

  assert {
    condition     = output.frontend_origin == "https://frontend-123456789012.europe-west1.run.app"
    error_message = "CORS origin and Discord redirect use the deterministic frontend URL."
  }
}

run "explicit_secret_versions" {
  command = plan

  variables {
    enable_auth_proxy                   = true
    discord_oauth_client_secret_version = "latest"
  }

  expect_failures = [var.discord_oauth_client_secret_version]
}

run "keeps_the_discord_backend" {
  command = plan

  variables {
    enable_auth_proxy    = true
    enable_discord_hello = true
  }

  assert {
    condition     = toset(keys(output.gateway_contract.backends)) == toset(["discord", "auth"])
    error_message = "The auth backend is added next to the Discord one, never instead of it."
  }
}
