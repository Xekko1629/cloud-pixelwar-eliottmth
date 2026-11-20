mock_provider "google" {
  mock_resource "google_cloud_run_v2_service" {
    defaults = { uri = "https://frontend-abc-ew.a.run.app" }
  }
  mock_data "google_project" {
    defaults = { number = "123456789012" }
  }
}

variables {
  project_id   = "pixelwar-test"
  environment  = "dev"
  state_bucket = "pixelwar-test-tfstate"
  image        = "europe-west1-docker.pkg.dev/pixelwar-test/pixelwar/frontend@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
}

override_data {
  target = data.terraform_remote_state.gateway
  values = {
    outputs = { gateway_url = "https://pixelwar-abc.ew.gateway.dev" }
  }
}

run "service_from_image_digest" {
  command = apply

  assert {
    condition = (
      google_cloud_run_v2_service.frontend[0].template[0].containers[0].image == var.image &&
      google_cloud_run_v2_service.frontend[0].template[0].containers[0].ports[0].container_port == 8080 &&
      google_cloud_run_v2_service.frontend[0].template[0].scaling[0].min_instance_count == 0 &&
      google_cloud_run_v2_service.frontend[0].template[0].scaling[0].max_instance_count == 2 &&
      !google_cloud_run_v2_service.frontend[0].deletion_protection
    )
    error_message = "One scale-to-zero service runs the image digest on port 8080, and destroy can delete it."
  }

  assert {
    condition = (
      output.frontend_url == "https://frontend-123456789012.europe-west1.run.app" &&
      output.discord_redirect_uri == "https://frontend-123456789012.europe-west1.run.app/auth/callback"
    )
    error_message = "Expose the deterministic URL, the origin the auth-proxy allows and redirects to."
  }
}

run "runtime_configuration" {
  command = plan

  variables {
    discord_client_id = "1234567890123456789"
  }

  assert {
    condition = {
      for env in google_cloud_run_v2_service.frontend[0].template[0].containers[0].env : env.name => env.value
      } == {
      APP_ENV           = "dev"
      GATEWAY_URL       = "https://pixelwar-abc.ew.gateway.dev"
      REALTIME_URL      = ""
      DISCORD_CLIENT_ID = "1234567890123456789"
    }
    error_message = "The container gets the public configuration of its environment, and nothing else."
  }
}

run "no_gateway_yet" {
  command = plan

  override_data {
    target = data.terraform_remote_state.gateway
    values = { outputs = { gateway_url = null } }
  }

  assert {
    condition     = [for env in google_cloud_run_v2_service.frontend[0].template[0].containers[0].env : env.value if env.name == "GATEWAY_URL"] == [""]
    error_message = "Without a published gateway, the frontend starts with an empty API URL."
  }
}

run "identity_without_roles_and_public_invoker" {
  command = plan

  assert {
    condition = (
      google_cloud_run_v2_service.frontend[0].template[0].service_account == google_service_account.frontend.email &&
      google_cloud_run_v2_service_iam_member.public[0].role == "roles/run.invoker" &&
      google_cloud_run_v2_service_iam_member.public[0].member == "allUsers"
    )
    error_message = "Dedicated identity; allUsers only gets run.invoker on this service."
  }
}

run "no_service_without_image" {
  command = plan

  variables {
    image = null
  }

  assert {
    condition     = length(google_cloud_run_v2_service.frontend) == 0 && length(google_cloud_run_v2_service_iam_member.public) == 0
    error_message = "Without an image (destroy, local plan), no service and no public binding."
  }
}

run "reject_tag_reference" {
  command = plan

  variables {
    image = "europe-west1-docker.pkg.dev/pixelwar-test/pixelwar/frontend:latest"
  }

  expect_failures = [var.image]
}

run "reject_image_of_another_project" {
  command = plan

  variables {
    image = "europe-west1-docker.pkg.dev/other-project/pixelwar/frontend@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  }

  expect_failures = [google_cloud_run_v2_service.frontend]
}

run "reject_realtime_url_with_path" {
  command = plan

  variables {
    realtime_url = "https://realtime.example.run.app/stream"
  }

  expect_failures = [var.realtime_url]
}
