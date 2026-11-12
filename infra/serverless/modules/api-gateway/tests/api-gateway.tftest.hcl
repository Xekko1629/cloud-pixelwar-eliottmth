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
    { path = "/discord/interactions", method = "post", backend = "discord", operation_id = "discordInteraction", summary = "Discord", deadline_seconds = 3, auth = "none" },
    { path = "/auth/login", method = "get", backend = "auth", operation_id = "authLogin", summary = "Login", auth = "none", cors = true },
    { path = "/auth/exchange", method = "post", backend = "auth", operation_id = "authExchange", summary = "Exchange", auth = "none", cors = true },
    { path = "/api/pixels", method = "post", backend = "api", operation_id = "drawPixels", summary = "Draw", cors = true },
    { path = "/hello", method = "get", backend = "hello", operation_id = "hello", summary = "Hello" },
  ]

  backends = {
    api     = { function_name = "web-proxy", uri = "https://web-proxy-abc-ew.a.run.app", service_type = "proxy" }
    discord = { function_name = "discord-proxy", uri = "https://discord-proxy-abc-ew.a.run.app", service_type = "proxy" }
    hello   = { function_name = "hello-proxy", uri = "https://hello-proxy-abc-ew.a.run.app", service_type = "proxy" }
    # Deployed but not referenced by any route: must not get an invoker grant.
    unused = { function_name = "unused-proxy", uri = "https://unused-proxy-abc-ew.a.run.app", service_type = "proxy" }
  }
}

run "routing" {
  command = plan

  assert {
    condition = toset(output.published_routes) == toset([
      "POST /discord/interactions (none)",
      "POST /api/pixels (firebase)",
      "OPTIONS /api/pixels (none)",
      "GET /hello (firebase)",
    ])
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

run "route_authentication" {
  command = plan

  assert {
    condition = (
      yamldecode(output.openapi).securityDefinitions.firebase["x-google-issuer"] == "https://securetoken.google.com/pixelwar-test" &&
      yamldecode(output.openapi).securityDefinitions.firebase["x-google-audiences"] == "pixelwar-test" &&
      yamldecode(output.openapi).securityDefinitions.firebase["x-google-jwks_uri"] == "https://www.googleapis.com/service_accounts/v1/metadata/x509/securetoken@system.gserviceaccount.com"
    )
    error_message = "The gateway must only accept Firebase ID tokens issued for this project."
  }

  assert {
    condition     = yamldecode(output.openapi).paths["/api/pixels"].post.security == [{ firebase = [] }]
    error_message = "/api/* must require a Firebase ID token at the gateway."
  }

  assert {
    condition     = !can(yamldecode(output.openapi).paths["/discord/interactions"].post.security)
    error_message = "Discord interactions stay public at the gateway: the proxy verifies the Ed25519 signature."
  }

  assert {
    condition = (
      !can(yamldecode(output.openapi).paths["/api/pixels"].options.security) &&
      yamldecode(output.openapi).paths["/api/pixels"].options["x-google-backend"].address == "https://web-proxy-abc-ew.a.run.app" &&
      yamldecode(output.openapi).paths["/api/pixels"].options.operationId == "drawPixelsPreflight"
    )
    error_message = "A CORS path gets an unauthenticated OPTIONS route answered by its backend."
  }

  assert {
    condition     = !can(yamldecode(output.openapi).paths["/discord/interactions"].options) && !can(yamldecode(output.openapi).paths["/hello"].options)
    error_message = "Only browser routes get a preflight route."
  }
}

run "auth_routes_preflight" {
  command = plan

  variables {
    backends = {
      auth = { function_name = "auth-proxy", uri = "https://auth-proxy-abc-ew.a.run.app", service_type = "proxy" }
    }
  }

  assert {
    condition = toset(output.published_routes) == toset([
      "GET /auth/login (none)",
      "POST /auth/exchange (none)",
      "OPTIONS /auth/login (none)",
      "OPTIONS /auth/exchange (none)",
    ])
    error_message = "/auth/* is public (the user has no token yet) and each path gets its preflight."
  }
}

run "reject_public_api_route" {
  command = plan

  variables {
    routes = [
      { path = "/api/pixels", method = "post", backend = "api", operation_id = "drawPixels", summary = "Draw", auth = "none" },
    ]
  }

  expect_failures = [var.routes]
}

run "reject_explicit_options_route" {
  command = plan

  variables {
    routes = [
      { path = "/hello", method = "options", backend = "hello", operation_id = "helloPreflight", summary = "Preflight", auth = "none" },
    ]
  }

  expect_failures = [var.routes]
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
    condition     = toset(keys(google_cloud_run_service_iam_member.gateway_invoker)) == toset(["api", "discord", "hello"])
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
