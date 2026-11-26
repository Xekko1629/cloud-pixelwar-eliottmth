# Realtime of the browser (DRAW-03a, ADR-0015): Security Rules and browser API key.
mock_provider "google" {
  mock_resource "google_storage_bucket_object" {
    defaults = { generation = 1 }
  }
  mock_resource "google_firebaserules_ruleset" {
    defaults = { name = "00000000-0000-0000-0000-000000000000" }
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
mock_provider "random" {}

variables {
  project_id  = "pixelwar-test"
  environment = "dev"
}

run "disabled_by_default" {
  command = plan

  assert {
    condition = (
      length(google_firebaserules_ruleset.firestore) == 0 &&
      length(google_firebaserules_release.firestore) == 0 &&
      length(google_apikeys_key.firestore_web) == 0 &&
      output.firestore_web_api_key == null
    )
    error_message = "Without enable_realtime (prd until P0-1, or before infra/iam enables the APIs), nothing is created."
  }
}

run "rules_of_the_repository_released_on_the_default_database" {
  command = apply

  variables {
    enable_realtime = true
  }

  assert {
    condition = (
      google_firebaserules_ruleset.firestore[0].source[0].files[0].content == file("${path.module}/firestore.rules") &&
      google_firebaserules_release.firestore[0].name == "cloud.firestore" &&
      google_firebaserules_release.firestore[0].ruleset_name == "projects/pixelwar-test/rulesets/00000000-0000-0000-0000-000000000000"
    )
    error_message = "Release the tested rules file (firestore.rules) on the (default) database."
  }

  assert {
    condition = (
      strcontains(file("${path.module}/firestore.rules"), "match /deltas/{delta}") &&
      strcontains(file("${path.module}/firestore.rules"), "match /config/global") &&
      !strcontains(file("${path.module}/firestore.rules"), "allow write: if true") &&
      !strcontains(file("${path.module}/firestore.rules"), "request.auth")
    )
    error_message = "Only deltas and config/global are readable, nothing is writable, and no rule relies on Firebase Auth."
  }
}

run "browser_key_limited_to_firestore_and_the_frontend" {
  command = apply

  variables {
    enable_realtime = true
  }

  assert {
    condition = (
      toset([for target in google_apikeys_key.firestore_web[0].restrictions[0].api_targets : target.service]) == toset(["firestore.googleapis.com"]) &&
      google_apikeys_key.firestore_web[0].restrictions[0].browser_key_restrictions[0].allowed_referrers == tolist([
        "https://frontend-123456789012.europe-west1.run.app/*",
      ]) &&
      startswith(google_apikeys_key.firestore_web[0].name, "firestore-web-")
    )
    error_message = "The key calls the Firestore API only, from the frontend pages only, under a suffixed name."
  }
}

run "extra_local_referrer_in_dev" {
  command = plan

  variables {
    enable_realtime          = true
    realtime_extra_referrers = ["http://localhost:5173/*"]
  }

  assert {
    condition = google_apikeys_key.firestore_web[0].restrictions[0].browser_key_restrictions[0].allowed_referrers == tolist([
      "https://frontend-123456789012.europe-west1.run.app/*",
      "http://localhost:5173/*",
    ])
    error_message = "A local Vite server may be added after the frontend."
  }
}

run "refuse_a_remote_http_or_unbounded_referrer" {
  command = plan

  variables {
    enable_realtime          = true
    realtime_extra_referrers = ["http://pixelwar.example.com/*", "*"]
  }

  expect_failures = [var.realtime_extra_referrers]
}
