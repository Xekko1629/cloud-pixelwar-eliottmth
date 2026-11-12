mock_provider "google" {}
mock_provider "google-beta" {}

# The service account email is only known after apply: fix it so plan-time assertions can compare it.
override_resource {
  target          = google_service_account.gateway
  override_during = plan
  values = {
    email  = "pixelwar-gateway@pixelwar-test.iam.gserviceaccount.com"
    member = "serviceAccount:pixelwar-gateway@pixelwar-test.iam.gserviceaccount.com"
  }
}

variables {
  project_id = "pixelwar-test"
  region     = "europe-west1"
  labels = {
    environment = "dev"
  }

  routes = [
    { path = "/discord/interactions", method = "post", backend = "discord", operation_id = "discordInteraction", summary = "Discord", deadline_seconds = 3 },
    { path = "/auth/login", method = "get", backend = "auth", operation_id = "authLogin", summary = "Login" },
    { path = "/auth/exchange", method = "post", backend = "auth", operation_id = "authExchange", summary = "Exchange" },
    { path = "/hello", method = "get", backend = "hello", operation_id = "hello", summary = "Hello" },
  ]

  backends = {
    discord = { function_name = "discord-proxy", uri = "https://discord-proxy-abc-ew.a.run.app", service_type = "proxy" }
    hello   = { function_name = "hello-proxy", uri = "https://hello-proxy-abc-ew.a.run.app", service_type = "proxy" }
    # Deployed but not referenced by any route: must not get an invoker grant.
    unused = { function_name = "unused-proxy", uri = "https://unused-proxy-abc-ew.a.run.app", service_type = "proxy" }
  }
}

run "routing" {
  command = plan

  assert {
    condition     = toset(output.published_routes) == toset(["POST /discord/interactions", "GET /hello"])
    error_message = "Only routes whose backend is deployed must be published."
  }

  assert {
    condition     = yamldecode(output.openapi).swagger == "2.0"
    error_message = "API Gateway only accepts OpenAPI 2.0."
  }

  assert {
    condition     = !contains(keys(yamldecode(output.openapi).paths), "/auth/login")
    error_message = "A route without a deployed backend must not appear in the spec."
  }

  assert {
    condition = (
      yamldecode(output.openapi).paths["/discord/interactions"].post["x-google-backend"].address == "https://discord-proxy-abc-ew.a.run.app" &&
      yamldecode(output.openapi).paths["/discord/interactions"].post["x-google-backend"].jwt_audience == "https://discord-proxy-abc-ew.a.run.app" &&
      yamldecode(output.openapi).paths["/discord/interactions"].post["x-google-backend"].path_translation == "APPEND_PATH_TO_ADDRESS" &&
      yamldecode(output.openapi).paths["/discord/interactions"].post["x-google-backend"].deadline == 3
    )
    error_message = "Each route must reach its proxy with a Cloud Run audience, its own path and its deadline."
  }

  assert {
    condition     = yamldecode(output.openapi).paths["/hello"].get["x-google-backend"].deadline == 15
    error_message = "Routes default to a 15 s deadline."
  }
}

run "immutable_config" {
  command = plan

  assert {
    condition     = google_api_gateway_api_config.main.api_config_id_prefix == "pixelwar-"
    error_message = "API configs are immutable: use a generated ID from a prefix, never a fixed ID."
  }

  assert {
    condition     = google_api_gateway_api_config.main.gateway_config[0].backend_config[0].google_service_account == google_service_account.gateway.email
    error_message = "The gateway must call the proxies with its dedicated service account."
  }

  assert {
    condition     = google_api_gateway_gateway.main.region == "europe-west1" && google_api_gateway_gateway.main.labels["environment"] == "dev"
    error_message = "The gateway must be regional and labelled."
  }
}

run "least_privilege" {
  command = plan

  assert {
    condition     = google_service_account.gateway.account_id == "pixelwar-gateway"
    error_message = "The gateway needs its own identity."
  }

  assert {
    condition     = toset(keys(google_cloud_run_service_iam_member.gateway_invoker)) == toset(["discord", "hello"])
    error_message = "run.invoker must be granted only on the proxies the gateway routes to."
  }

  assert {
    condition     = google_cloud_run_service_iam_member.gateway_invoker["discord"].service == "discord-proxy"
    error_message = "The grant targets the Cloud Run service underlying the proxy function."
  }

  assert {
    condition = alltrue([
      for grant in google_cloud_run_service_iam_member.gateway_invoker :
      grant.role == "roles/run.invoker" && grant.member == google_service_account.gateway.member
    ])
    error_message = "Grants must be service-scoped run.invoker for the gateway identity only."
  }
}

run "reject_empty_spec" {
  command = plan

  variables {
    backends = {}
  }

  expect_failures = [google_api_gateway_api_config.main]
}

run "reject_duplicate_route" {
  command = plan

  variables {
    routes = [
      { path = "/hello", method = "get", backend = "hello", operation_id = "hello", summary = "Hello" },
      { path = "/hello", method = "get", backend = "hello", operation_id = "helloAgain", summary = "Hello again" },
    ]
  }

  expect_failures = [var.routes]
}

run "reject_worker_backend" {
  command = plan

  variables {
    backends = {
      hello = { function_name = "draw-worker", uri = "https://draw-worker-abc-ew.a.run.app", service_type = "worker" }
    }
  }

  expect_failures = [var.backends]
}
