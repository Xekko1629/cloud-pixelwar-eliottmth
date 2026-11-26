# Warm-up jobs (ADR-0017). All applies use mocks exclusively: no credentials, cloud or remote state.
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
  target = google_service_account.warmer
  values = {
    email  = "function-warmer@pixelwar-test.iam.gserviceaccount.com"
    member = "serviceAccount:function-warmer@pixelwar-test.iam.gserviceaccount.com"
    name   = "projects/pixelwar-test/serviceAccounts/function-warmer@pixelwar-test.iam.gserviceaccount.com"
  }
}

variables {
  project_id              = "pixelwar-test"
  environment             = "dev"
  enable_discord_pipeline = true
  enable_discord_delivery = true
  enable_web_api          = true
  enable_auth_proxy       = true
}

run "warms_every_user_facing_function" {
  command = apply

  assert {
    condition = toset(keys(google_cloud_scheduler_job.warmup)) == toset([
      "command-worker", "draw-worker", "discord-notifier", "admin-worker", "render-worker",
      "web-proxy", "tile-reader", "auth-proxy",
    ])
    error_message = "One job per function of a command or of the site; not the frontend, not discord-hello, not the Discord proxy (warmed through the gateway)."
  }
  assert {
    condition = alltrue([for name, job in google_cloud_scheduler_job.warmup : (
      job.name == "warmup-${name}" && job.schedule == "* * * * *" && job.region == "europe-west1" &&
      job.retry_config[0].retry_count == 0 && job.attempt_deadline == "15s" &&
      job.http_target[0].http_method == "GET" &&
      job.http_target[0].uri == "https://function-test-ew.a.run.app/health" &&
      job.http_target[0].oidc_token[0].audience == "https://function-test-ew.a.run.app" &&
      job.http_target[0].oidc_token[0].service_account_email == "function-warmer@pixelwar-test.iam.gserviceaccount.com"
    )])
    error_message = "Every minute, GET /health on the run.app URL with an OIDC token of the warmer for that URL, never retried."
  }
  assert {
    condition = (
      length(google_service_account.warmer) == 1 &&
      google_service_account.warmer[0].account_id == "function-warmer" &&
      toset(keys(google_cloud_run_service_iam_member.warmer_invoker)) == toset(keys(google_cloud_scheduler_job.warmup)) &&
      alltrue([for name, binding in google_cloud_run_service_iam_member.warmer_invoker : (
        binding.service == name && binding.role == "roles/run.invoker" && binding.location == "europe-west1" &&
        binding.member == "serviceAccount:function-warmer@pixelwar-test.iam.gserviceaccount.com"
      )])
    )
    error_message = "A dedicated identity whose only right is run.invoker on each warmed function."
  }
  assert {
    condition     = output.warmup_jobs["render-worker"] == "warmup-render-worker"
    error_message = "The output lists the jobs by function."
  }
}

run "null_schedule_disables_the_warmer" {
  command = plan
  variables { warmup_schedule = null }

  assert {
    condition = (
      length(google_service_account.warmer) == 0 && length(google_cloud_run_service_iam_member.warmer_invoker) == 0 &&
      length(google_cloud_scheduler_job.warmup) == 0
    )
    error_message = "warmup_schedule = null removes the jobs, the bindings and the identity."
  }
}

run "follows_the_deployed_functions" {
  command = plan
  variables {
    enable_discord_pipeline = false
    enable_discord_delivery = false
    enable_web_api          = false
  }

  assert {
    condition     = toset(keys(google_cloud_scheduler_job.warmup)) == toset(["auth-proxy"])
    error_message = "Only deployed functions are warmed."
  }
}

run "nothing_deployed_nothing_created" {
  command = plan
  variables {
    enable_discord_pipeline = false
    enable_discord_delivery = false
    enable_web_api          = false
    enable_auth_proxy       = false
  }

  assert {
    condition     = length(google_service_account.warmer) == 0 && length(google_cloud_scheduler_job.warmup) == 0
    error_message = "No warmer identity without a function to warm."
  }
}
