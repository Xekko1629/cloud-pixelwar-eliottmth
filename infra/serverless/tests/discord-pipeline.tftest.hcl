# All applies below use mocks exclusively: no credentials, cloud or remote state.
mock_provider "google" {
  mock_resource "google_storage_bucket_object" {
    defaults = { generation = 1 }
  }
  mock_resource "google_cloudfunctions2_function" {
    defaults = { service_config = { uri = "https://worker-test-ew.a.run.app" } }
  }
  mock_resource "google_service_account" {
    defaults = {
      email  = "test-runtime@pixelwar-test.iam.gserviceaccount.com"
      member = "serviceAccount:test-runtime@pixelwar-test.iam.gserviceaccount.com"
      name   = "projects/pixelwar-test/serviceAccounts/test-runtime@pixelwar-test.iam.gserviceaccount.com"
    }
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
  target = module.discord_proxy[0].google_service_account.runtime
  values = {
    email  = "discord-proxy@pixelwar-test.iam.gserviceaccount.com"
    member = "serviceAccount:discord-proxy@pixelwar-test.iam.gserviceaccount.com"
    name   = "projects/pixelwar-test/serviceAccounts/discord-proxy@pixelwar-test.iam.gserviceaccount.com"
  }
}
override_resource {
  target = module.command_worker[0].google_service_account.invoker[0]
  values = {
    email  = "command-invoker@pixelwar-test.iam.gserviceaccount.com"
    member = "serviceAccount:command-invoker@pixelwar-test.iam.gserviceaccount.com"
    name   = "projects/pixelwar-test/serviceAccounts/command-invoker@pixelwar-test.iam.gserviceaccount.com"
  }
}
override_resource {
  target = module.command_worker[0].google_service_account.runtime
  values = {
    email  = "command-worker@pixelwar-test.iam.gserviceaccount.com"
    member = "serviceAccount:command-worker@pixelwar-test.iam.gserviceaccount.com"
    name   = "projects/pixelwar-test/serviceAccounts/command-worker@pixelwar-test.iam.gserviceaccount.com"
  }
}
override_resource {
  target = module.draw_worker[0].google_service_account.runtime
  values = {
    email  = "draw-worker@pixelwar-test.iam.gserviceaccount.com"
    member = "serviceAccount:draw-worker@pixelwar-test.iam.gserviceaccount.com"
    name   = "projects/pixelwar-test/serviceAccounts/draw-worker@pixelwar-test.iam.gserviceaccount.com"
  }
}

variables {
  project_id  = "pixelwar-test"
  environment = "dev"
}

run "disabled_by_default" {
  command = plan

  assert {
    condition = (
      length(module.discord_proxy) == 0 && length(module.command_worker) == 0 &&
      length(module.draw_worker) == 0 && length(module.discord_notifier) == 0 &&
      length(module.admin_worker) == 0 && length(module.admin_requested) == 0 &&
      length(module.command_rejected) == 0 && length(module.admin_worker_subscription) == 0 &&
      length(module.notifier_command_rejected_subscription) == 0 &&
      length(google_project_iam_member.admin_worker_firestore) == 0 &&
      length(module.discord_commands) == 0 && length(module.pixel_draw) == 0 &&
      length(module.pixel_processed) == 0 && length(module.pixel_rejected) == 0 &&
      length(module.command_worker_subscription) == 0 && length(module.draw_worker_subscription) == 0 &&
      length(module.notifier_processed_subscription) == 0 && length(module.notifier_rejected_subscription) == 0 &&
      length(google_project_service_identity.discord_pubsub) == 0 &&
      length(google_service_account_iam_member.push_token_creator) == 0 &&
      length(google_project_iam_member.draw_worker_firestore) == 0
    )
    error_message = "No /draw function, topic, subscription or IAM grant may exist without opt-in."
  }
}

run "phase_one_creates_functions_and_topics_without_delivery" {
  command = apply
  variables {
    enable_discord_pipeline = true
    enable_discord_hello    = true
  }
  assert {
    condition = (
      length(module.command_worker) == 1 && length(module.draw_worker) == 1 && length(module.discord_notifier) == 1 &&
      module.pixel_draw[0].name == "pixel-draw" && module.pixel_processed[0].name == "pixel-processed" &&
      module.pixel_rejected[0].name == "pixel-rejected" &&
      length(module.command_worker_subscription) == 0 && length(module.draw_worker_subscription) == 0 &&
      length(google_service_account_iam_member.push_token_creator) == 0 &&
      output.gateway_contract.backends.discord.function_name == "discord-hello"
    )
    error_message = "Phase 1 creates the workers and topics, without push delivery and without switching hello."
  }
}

run "delivery_wires_the_draw_path" {
  command = apply
  variables {
    enable_discord_pipeline = true
    enable_discord_delivery = true
    enable_discord_hello    = true
  }

  assert {
    condition = (
      module.command_worker[0].service_type == "worker" && module.draw_worker[0].service_type == "worker" &&
      module.discord_notifier[0].service_type == "worker" &&
      output.gateway_contract.backends.discord.function_name == "discord-hello"
    )
    error_message = "Delivery wires private workers and keeps hello routed until the explicit switch."
  }
  assert {
    condition = (
      module.command_worker_subscription[0].name == "command-worker" &&
      module.draw_worker_subscription[0].name == "draw-worker" &&
      module.notifier_processed_subscription[0].name == "discord-notifier-processed" &&
      module.notifier_rejected_subscription[0].name == "discord-notifier-rejected" &&
      module.command_worker_subscription[0].path == local.command_worker_subscription &&
      module.draw_worker_subscription[0].path == local.draw_worker_subscription &&
      module.notifier_processed_subscription[0].path == local.notifier_processed_subscription &&
      module.notifier_rejected_subscription[0].path == local.notifier_rejected_subscription
    )
    error_message = "Subscription names follow docs/events.md 7.1 and match the names each worker checks."
  }
  assert {
    condition = (
      module.command_worker[0].invoker_service_account_email != module.command_worker[0].service_account_email &&
      module.discord_proxy[0].invoker_service_account_email == null &&
      toset(keys(google_service_account_iam_member.push_token_creator)) == toset(["command_worker", "draw_worker", "discord_notifier", "admin_worker"]) &&
      google_service_account_iam_member.push_token_creator["command_worker"].service_account_id == module.command_worker[0].invoker_service_account_name &&
      google_service_account_iam_member.push_token_creator["command_worker"].role == "roles/iam.serviceAccountTokenCreator" &&
      google_service_account_iam_member.push_token_creator["command_worker"].member == "serviceAccount:service-123456789@gcp-sa-pubsub.iam.gserviceaccount.com"
    )
    error_message = "The Pub/Sub agent signs push tokens with one scoped grant per worker invoker, never with a runtime identity."
  }
  assert {
    condition = (
      google_project_iam_member.draw_worker_firestore[0].role == "roles/datastore.user" &&
      google_project_iam_member.draw_worker_firestore[0].member == "serviceAccount:draw-worker@pixelwar-test.iam.gserviceaccount.com"
    )
    error_message = "Only the draw-worker runtime gets Firestore access on this path."
  }
}

run "delivery_wires_the_admin_path" {
  command = apply
  variables {
    enable_discord_pipeline = true
    enable_discord_delivery = true
    enable_discord_hello    = true
  }

  assert {
    condition = (
      module.admin_worker[0].service_type == "worker" &&
      module.admin_requested[0].name == "admin-requested" && module.command_rejected[0].name == "command-rejected" &&
      module.admin_worker_subscription[0].path == local.admin_worker_subscription &&
      module.notifier_command_rejected_subscription[0].path == local.notifier_command_rejected_subscription &&
      module.notifier_command_rejected_subscription[0].name == "discord-notifier-command-rejected"
    )
    error_message = "The admin path wires admin-requested to the admin-worker and command-rejected to the notifier, with the names each worker checks."
  }
  assert {
    condition = (
      google_project_iam_member.admin_worker_firestore[0].role == "roles/datastore.user" &&
      google_service_account_iam_member.push_token_creator["admin_worker"].service_account_id == module.admin_worker[0].invoker_service_account_name
    )
    error_message = "The admin-worker writes Firestore and gets pushes through its own invoker."
  }
}

run "switch_to_proxy_after_delivery" {
  command = apply
  variables {
    enable_discord_pipeline = true
    enable_discord_delivery = true
    enable_discord_hello    = true
    use_discord_proxy       = true
  }
  assert {
    condition = (
      output.gateway_contract.backends.discord.function_name == "discord-proxy" &&
      output.gateway_contract.backends.discord.uri == module.discord_proxy[0].uri &&
      length(module.discord_hello) == 1 && length(module.command_worker_subscription) == 1
    )
    error_message = "Only an explicit routing choice selects the proxy, keeping hello and the workers."
  }
}

run "rollback_keeps_pipeline" {
  command = apply
  variables {
    enable_discord_pipeline = true
    enable_discord_delivery = true
    enable_discord_hello    = true
    use_discord_proxy       = false
  }
  assert {
    condition = (
      output.gateway_contract.backends.discord.function_name == "discord-hello" &&
      length(module.command_worker) == 1 && length(module.draw_worker_subscription) == 1 &&
      length(module.notifier_rejected_subscription) == 1
    )
    error_message = "Routing rollback must not delete workers or subscriptions (and the messages they hold)."
  }
}

run "never_create_in_prd_even_with_flags" {
  command = plan
  variables {
    environment             = "prd"
    enable_discord_pipeline = true
    enable_discord_delivery = true
    enable_discord_hello    = true
    use_discord_proxy       = true
  }
  assert {
    condition = (
      length(module.discord_proxy) == 0 && length(module.command_worker) == 0 &&
      length(module.draw_worker) == 0 && length(module.discord_notifier) == 0 &&
      length(module.pixel_draw) == 0 && length(module.command_worker_subscription) == 0 &&
      length(google_service_account_iam_member.push_token_creator) == 0 &&
      length(output.gateway_contract.backends) == 0
    )
    error_message = "Dev-only guards must override all opt-in flags in prd."
  }
}

run "refuse_routing_without_pipeline" {
  command = plan
  variables { use_discord_proxy = true }
  expect_failures = [output.gateway_contract]
}

run "refuse_routing_before_delivery" {
  command = plan
  variables {
    enable_discord_pipeline = true
    use_discord_proxy       = true
  }
  expect_failures = [output.gateway_contract]
}

run "refuse_delivery_without_pipeline" {
  command = plan
  variables { enable_discord_delivery = true }
  expect_failures = [output.gateway_contract]
}

run "reject_latest_public_key" {
  command = plan
  variables { discord_proxy_public_key_version = "latest" }
  expect_failures = [var.discord_proxy_public_key_version]
}

run "reject_latest_application_id" {
  command = plan
  variables { discord_application_id_version = "latest" }
  expect_failures = [var.discord_application_id_version]
}

run "reject_latest_admin_allowlist" {
  command = plan
  variables { admin_allowlist_version = "latest" }
  expect_failures = [var.admin_allowlist_version]
}
