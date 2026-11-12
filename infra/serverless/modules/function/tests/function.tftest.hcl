mock_provider "google" {}

variables {
  project_id = "pixelwar-test"
  region     = "europe-west1"
  name       = "discord-proxy"
  source_archive = {
    bucket     = "pixelwar-test-function-sources"
    object     = "functions/discord-proxy/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.zip"
    generation = "123456789"
    sha256     = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  }
  entry_point           = "handleRequest"
  build_service_account = "projects/pixelwar-test/serviceAccounts/function-builder@pixelwar-test.iam.gserviceaccount.com"
  build_repository      = "projects/pixelwar-test/locations/europe-west1/repositories/pixelwar"
  labels                = { environment = "dev" }
}

run "private_http_function" {
  command = plan

  assert {
    condition     = google_cloudfunctions2_function.main.service_config[0].ingress_settings == "ALLOW_INTERNAL_ONLY"
    error_message = "Workers must use internal ingress."
  }
  assert {
    condition = (
      length(google_cloudfunctions2_function.main.event_trigger) == 0 &&
      google_cloudfunctions2_function.main.build_config[0].runtime == "nodejs24" &&
      google_cloudfunctions2_function.main.build_config[0].entry_point == "handleRequest"
    )
    error_message = "Use Gen2 Node 24 HTTP handlers, not a native Eventarc trigger."
  }
  assert {
    condition = (
      length(google_service_account.invoker) == 1 &&
      google_service_account.invoker[0].account_id != google_service_account.runtime.account_id &&
      google_cloud_run_service_iam_member.push_invoker[0].role == "roles/run.invoker"
    )
    error_message = "Workers need a distinct push identity and Gen2 underlying-service invoker grant."
  }
  assert {
    condition = (
      google_cloudfunctions2_function.main.service_config[0].min_instance_count == 0 &&
      google_cloudfunctions2_function.main.service_config[0].max_instance_count == 5 &&
      google_cloudfunctions2_function.main.service_config[0].max_instance_request_concurrency == 1
    )
    error_message = "Keep scale-to-zero, instance cap and conservative concurrency."
  }
  assert {
    condition = (
      google_service_account.runtime.account_id == "discord-proxy" &&
      length(google_project_iam_member.observability) == 4 &&
      google_project_iam_member.observability["roles/telemetry.tracesWriter"].role == "roles/telemetry.tracesWriter"
    )
    error_message = "Each runtime needs a dedicated identity and observability grants."
  }
  assert {
    condition     = google_cloudfunctions2_function.main.deletion_policy == "DELETE"
    error_message = "Functions remain disposable by default."
  }
}

run "pinned_archive_and_separate_builder" {
  command = plan
  assert {
    condition = (
      google_cloudfunctions2_function.main.build_config[0].source[0].storage_source[0].generation == 123456789 &&
      endswith(google_cloudfunctions2_function.main.build_config[0].source[0].storage_source[0].object, "/${var.source_archive.sha256}.zip") &&
      google_cloudfunctions2_function.main.build_config[0].service_account == var.build_service_account &&
      google_cloudfunctions2_function.main.build_config[0].docker_repository == var.build_repository
    )
    error_message = "Pin exact GCS generation and route Google's build through an explicit build SA/repository."
  }
  assert {
    condition     = output.source_archive.sha256 == var.source_archive.sha256
    error_message = "Release output must retain the source checksum."
  }
}

run "gateway_proxy" {
  command = plan
  variables { service_type = "proxy" }
  assert {
    condition = (
      google_cloudfunctions2_function.main.service_config[0].ingress_settings == "ALLOW_ALL" &&
      length(google_service_account.invoker) == 0 &&
      length(google_cloud_run_service_iam_member.push_invoker) == 0
    )
    error_message = "Gateway proxies accept network traffic without granting public IAM or a worker push identity."
  }
  assert {
    condition     = output.service_type == "proxy"
    error_message = "The service type is exported so the gateway can refuse worker backends."
  }
}

run "configured_function" {
  command = plan
  variables {
    min_instances         = 1
    max_instances         = 10
    concurrency           = 8
    timeout_seconds       = 120
    memory                = "2Gi"
    deletion_protection   = true
    environment_variables = { APP_ENV = "prd" }
    secrets = {
      BOT_TOKEN = { secret = "discord-bot-token", version = "1" }
    }
  }
  assert {
    condition = (
      google_cloudfunctions2_function.main.service_config[0].timeout_seconds == 120 &&
      google_cloudfunctions2_function.main.service_config[0].available_memory == "2Gi" &&
      google_cloudfunctions2_function.main.deletion_policy == "PREVENT"
    )
    error_message = "Function timeout/memory/deletion protection must be configurable."
  }
  assert {
    condition = (
      google_secret_manager_secret_iam_member.runtime["discord-bot-token"].role == "roles/secretmanager.secretAccessor" &&
      google_cloudfunctions2_function.main.service_config[0].secret_environment_variables[0].key == "BOT_TOKEN" &&
      google_cloudfunctions2_function.main.service_config[0].secret_environment_variables[0].version == "1" &&
      google_cloudfunctions2_function.main.service_config[0].environment_variables["APP_ENV"] == "prd"
    )
    error_message = "Inject secret references and runtime variables, never values or environment-specific build inputs."
  }
}

run "reject_unknown_service_type" {
  command = plan
  variables { service_type = "public" }
  expect_failures = [var.service_type]
}

run "reject_unpinned_generation" {
  command = plan
  variables {
    source_archive = {
      bucket     = "pixelwar-test-function-sources", object = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.zip",
      generation = "latest", sha256 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    }
  }
  expect_failures = [var.source_archive]
}

run "reject_zero_generation" {
  command = plan
  variables {
    source_archive = {
      bucket     = "pixelwar-test-function-sources", object = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.zip",
      generation = "0", sha256 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    }
  }
  expect_failures = [var.source_archive]
}

run "bare_archive_name" {
  command = plan
  variables {
    source_archive = {
      bucket     = "pixelwar-test-function-sources", object = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.zip",
      generation = "123456789", sha256 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    }
  }
}

run "reject_generation_overflow" {
  command = plan
  variables {
    source_archive = {
      bucket     = "pixelwar-test-function-sources", object = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.zip",
      generation = "9223372036854775808", sha256 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    }
  }
  expect_failures = [var.source_archive]
}

run "reject_mutable_object_name" {
  command = plan
  variables {
    source_archive = {
      bucket     = "pixelwar-test-function-sources", object = "function-latest.zip",
      generation = "123456789", sha256 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    }
  }
  expect_failures = [var.source_archive]
}

run "reject_invalid_checksum" {
  command = plan
  variables {
    source_archive = {
      bucket     = "pixelwar-test-function-sources", object = "not-a-hash.zip",
      generation = "123456789", sha256 = "not-a-hash"
    }
  }
  expect_failures = [var.source_archive]
}

run "reject_default_compute_builder" {
  command = plan
  variables { build_service_account = "projects/pixelwar-test/serviceAccounts/123456789-compute@developer.gserviceaccount.com" }
  expect_failures = [var.build_service_account]
}

run "reject_runtime_as_builder" {
  command = plan
  variables { build_service_account = "projects/pixelwar-test/serviceAccounts/discord-proxy@pixelwar-test.iam.gserviceaccount.com" }
  expect_failures = [var.build_service_account]
}

run "reject_other_project_repository" {
  command = plan
  variables { build_repository = "projects/other-project/locations/europe-west1/repositories/pixelwar" }
  expect_failures = [var.build_repository]
}

run "reject_invalid_entry_point" {
  command = plan
  variables { entry_point = "" }
  expect_failures = [var.entry_point]
}

run "reject_invalid_scaling" {
  command = plan
  variables { min_instances = 6 }
  expect_failures = [google_cloudfunctions2_function.main]
}

run "reject_duplicate_environment_variable" {
  command = plan
  variables {
    environment_variables = { BOT_TOKEN = "not-a-secret" }
    secrets               = { BOT_TOKEN = { secret = "discord-bot-token", version = "1" } }
  }
  expect_failures = [google_cloudfunctions2_function.main]
}

run "reject_latest_secret_version" {
  command = plan
  variables { secrets = { BOT_TOKEN = { secret = "discord-bot-token", version = "latest" } } }
  expect_failures = [var.secrets]
}
