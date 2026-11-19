# All applies below use mocks exclusively: no credentials, cloud or remote state.
mock_provider "google" {
  mock_resource "google_storage_bucket_object" {
    defaults = { generation = 1 }
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
  target = module.discord_command_verify[0].google_service_account.invoker[0]
  values = {
    email  = "verify-invoker@pixelwar-test.iam.gserviceaccount.com"
    member = "serviceAccount:verify-invoker@pixelwar-test.iam.gserviceaccount.com"
    name   = "projects/pixelwar-test/serviceAccounts/verify-invoker@pixelwar-test.iam.gserviceaccount.com"
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
      length(module.discord_proxy) == 0 && length(module.discord_proxy_source) == 0 &&
      length(module.discord_command_verify) == 0 && length(module.discord_command_verify_source) == 0 &&
      length(module.discord_commands) == 0 && length(module.discord_command_dlq) == 0 &&
      length(google_pubsub_subscription.discord_verify) == 0 && length(google_pubsub_subscription.discord_verify_dlq) == 0 &&
      length(google_project_service_identity.discord_pubsub) == 0 &&
      length(google_service_account_iam_member.discord_verify_token_creator) == 0 &&
      length(google_pubsub_topic_iam_member.discord_verify_dlq_publisher) == 0 &&
      length(google_pubsub_subscription_iam_member.discord_verify_dlq_forwarder) == 0
    )
    error_message = "No diagnostic resource or IAM grant may exist without opt-in."
  }
}

run "create_dev_pipeline_without_switching_gateway" {
  command = apply
  variables {
    enable_discord_pipeline = true
    enable_discord_delivery = true
    enable_discord_hello    = true
  }

  assert {
    condition = (
      module.discord_proxy[0].service_type == "proxy" && module.discord_proxy[0].name == "discord-proxy" &&
      module.discord_command_verify[0].service_type == "worker" && module.discord_command_verify[0].name == "discord-command-verify" &&
      output.gateway_contract.backends.discord.function_name == "discord-hello" &&
      toset(keys(output.gateway_contract.backends)) == toset(["discord"])
    )
    error_message = "Creating the diagnostic pipeline must keep hello as the only routed backend; never export the worker."
  }
  assert {
    condition = (
      module.discord_commands[0].name == "discord-command" &&
      google_pubsub_subscription.discord_verify[0].topic == module.discord_commands[0].id &&
      google_pubsub_subscription.discord_verify_dlq[0].topic == module.discord_command_dlq[0].id &&
      google_pubsub_subscription.discord_verify[0].name == "discord-command-verify"
    )
    error_message = "Main and DLQ subscriptions must point to their respective topics and use the configured worker subscription name."
  }
  assert {
    condition = (
      google_pubsub_subscription.discord_verify[0].push_config[0].push_endpoint == module.discord_command_verify[0].uri &&
      google_pubsub_subscription.discord_verify[0].push_config[0].oidc_token[0].audience == module.discord_command_verify[0].uri &&
      google_pubsub_subscription.discord_verify[0].push_config[0].oidc_token[0].service_account_email == module.discord_command_verify[0].invoker_service_account_email &&
      module.discord_command_verify[0].invoker_service_account_email != module.discord_command_verify[0].service_account_email &&
      module.discord_proxy[0].invoker_service_account_email == null
    )
    error_message = "Push must use the private worker URI as endpoint/audience and its dedicated invoker, not its runtime or the proxy."
  }
  assert {
    condition = (
      google_service_account_iam_member.discord_verify_token_creator[0].service_account_id == module.discord_command_verify[0].invoker_service_account_name &&
      google_service_account_iam_member.discord_verify_token_creator[0].role == "roles/iam.serviceAccountTokenCreator" &&
      google_service_account_iam_member.discord_verify_token_creator[0].member == "serviceAccount:service-123456789@gcp-sa-pubsub.iam.gserviceaccount.com" &&
      google_pubsub_topic_iam_member.discord_verify_dlq_publisher[0].topic == module.discord_command_dlq[0].name &&
      google_pubsub_topic_iam_member.discord_verify_dlq_publisher[0].role == "roles/pubsub.publisher" &&
      google_pubsub_topic_iam_member.discord_verify_dlq_publisher[0].member == google_service_account_iam_member.discord_verify_token_creator[0].member &&
      google_pubsub_subscription_iam_member.discord_verify_dlq_forwarder[0].subscription == google_pubsub_subscription.discord_verify[0].name &&
      google_pubsub_subscription_iam_member.discord_verify_dlq_forwarder[0].role == "roles/pubsub.subscriber" &&
      google_pubsub_subscription_iam_member.discord_verify_dlq_forwarder[0].member == google_service_account_iam_member.discord_verify_token_creator[0].member
    )
    error_message = "The managed Pub/Sub agent needs scoped token creation and both forwarding permissions, not the worker runtime."
  }
  assert {
    condition = (
      google_pubsub_subscription.discord_verify[0].ack_deadline_seconds == 30 &&
      google_pubsub_subscription.discord_verify[0].retry_policy[0].minimum_backoff == "10s" &&
      google_pubsub_subscription.discord_verify[0].retry_policy[0].maximum_backoff == "60s" &&
      google_pubsub_subscription.discord_verify[0].dead_letter_policy[0].max_delivery_attempts == 5 &&
      google_pubsub_subscription.discord_verify[0].dead_letter_policy[0].dead_letter_topic == module.discord_command_dlq[0].id &&
      google_pubsub_subscription.discord_verify[0].message_retention_duration == "604800s" &&
      google_pubsub_subscription.discord_verify_dlq[0].message_retention_duration == "604800s" &&
      !google_pubsub_subscription.discord_verify[0].retain_acked_messages &&
      !google_pubsub_subscription.discord_verify_dlq[0].retain_acked_messages &&
      google_pubsub_subscription.discord_verify[0].expiration_policy[0].ttl == "" &&
      google_pubsub_subscription.discord_verify_dlq[0].expiration_policy[0].ttl == ""
    )
    error_message = "Use explicit 30s acknowledgement, 10-60s retries, approximate 5-attempt DLQ and 7-day unacked retention without idle expiration."
  }
}

run "explicit_switch_to_proxy" {
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
      length(module.discord_hello) == 1 && length(google_pubsub_subscription.discord_verify) == 1
    )
    error_message = "Only an explicit routing choice selects the proxy, retaining hello and diagnostic resources."
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
      length(module.discord_proxy) == 1 && length(module.discord_command_verify) == 1 &&
      length(google_pubsub_subscription.discord_verify) == 1 && length(google_pubsub_subscription.discord_verify_dlq) == 1
    )
    error_message = "Routing rollback must not disable or delete diagnostic functions or subscriptions."
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
      length(module.discord_proxy) == 0 && length(module.discord_proxy_source) == 0 &&
      length(module.discord_command_verify) == 0 && length(module.discord_command_verify_source) == 0 &&
      length(module.discord_commands) == 0 && length(module.discord_command_dlq) == 0 &&
      length(google_pubsub_subscription.discord_verify) == 0 && length(google_pubsub_subscription.discord_verify_dlq) == 0 &&
      length(google_project_service_identity.discord_pubsub) == 0 &&
      length(google_service_account_iam_member.discord_verify_token_creator) == 0 &&
      length(google_pubsub_topic_iam_member.discord_verify_dlq_publisher) == 0 &&
      length(google_pubsub_subscription_iam_member.discord_verify_dlq_forwarder) == 0 &&
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

run "phase_one_creates_resources_without_delivery" {
  command = apply
  variables {
    enable_discord_pipeline = true
    enable_discord_hello    = true
  }
  assert {
    condition = (
      length(module.discord_proxy) == 1 && length(module.discord_command_verify) == 1 &&
      length(module.discord_commands) == 1 && length(module.discord_command_dlq) == 1 &&
      length(google_pubsub_subscription.discord_verify_dlq) == 1 &&
      length(google_pubsub_subscription.discord_verify) == 0 &&
      length(google_service_account_iam_member.discord_verify_token_creator) == 0 &&
      length(google_pubsub_topic_iam_member.discord_verify_dlq_publisher) == 0 &&
      length(google_pubsub_subscription_iam_member.discord_verify_dlq_forwarder) == 0 &&
      output.discord_verify_invoker.email == module.discord_command_verify[0].invoker_service_account_email &&
      output.gateway_contract.backends.discord.function_name == "discord-hello"
    )
    error_message = "Phase 1 must create the invoker and DLQ cursor without managing its policy, creating push delivery, or switching hello."
  }
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
