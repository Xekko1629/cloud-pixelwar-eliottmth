mock_provider "google" {}

variables {
  project_id = "pixelwar-test"
  region     = "europe-west1"
  name       = "discord-proxy"
  image      = "europe-west1-docker.pkg.dev/pixelwar-test/pixelwar/proxy@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  labels = {
    environment = "dev"
  }
}

run "private_service" {
  command = plan

  assert {
    condition     = google_cloud_run_v2_service.main.invoker_iam_disabled == false
    error_message = "Cloud Run must keep IAM authentication enabled."
  }

  assert {
    condition     = google_cloud_run_v2_service.main.template[0].scaling[0].min_instance_count == 0 && google_cloud_run_v2_service.main.template[0].scaling[0].max_instance_count == 5
    error_message = "Default scaling must allow scale-to-zero and cap at 5 instances."
  }

  assert {
    condition     = google_cloud_run_v2_service.main.template[0].max_instance_request_concurrency == 1
    error_message = "Default concurrency must protect downstream services."
  }

  assert {
    condition     = google_service_account.runtime.account_id == "discord-proxy" && length(google_project_iam_member.observability) == 3
    error_message = "Each service needs a dedicated runtime identity with observability roles."
  }
}

run "configured_service" {
  command = plan

  variables {
    min_instances   = 1
    max_instances   = 10
    concurrency     = 8
    timeout_seconds = 120
    memory          = "2Gi"
    environment_variables = {
      APP_ENV = "prd"
    }
    secrets = {
      BOT_TOKEN = {
        secret  = "discord-bot-token"
        version = "1"
      }
    }
  }

  assert {
    condition     = google_cloud_run_v2_service.main.template[0].timeout == "120s" && google_cloud_run_v2_service.main.template[0].containers[0].resources[0].limits["memory"] == "2Gi"
    error_message = "Timeout and memory must be configurable."
  }

  assert {
    condition     = google_secret_manager_secret_iam_member.runtime["discord-bot-token"].role == "roles/secretmanager.secretAccessor"
    error_message = "Secret access must be granted on the specific secret."
  }

  assert {
    condition     = length(google_cloud_run_v2_service.main.template[0].containers[0].env) == 2
    error_message = "Plain variables and secret references must both be injected."
  }
}

run "reject_mutable_image" {
  command = plan
  variables {
    image = "europe-west1-docker.pkg.dev/pixelwar-test/pixelwar/proxy:latest"
  }
  expect_failures = [var.image]
}

run "reject_invalid_scaling" {
  command = plan
  variables {
    min_instances = 6
    max_instances = 5
  }
  expect_failures = [google_cloud_run_v2_service.main]
}

run "reject_duplicate_environment_variable" {
  command = plan
  variables {
    environment_variables = { BOT_TOKEN = "not-a-secret" }
    secrets = {
      BOT_TOKEN = {
        secret  = "discord-bot-token"
        version = "1"
      }
    }
  }
  expect_failures = [google_cloud_run_v2_service.main]
}
