# All applies below use mocks exclusively: no credentials, cloud or remote state.
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
  target = module.tile_reader[0].google_service_account.runtime
  values = {
    email  = "tile-reader@pixelwar-test.iam.gserviceaccount.com"
    member = "serviceAccount:tile-reader@pixelwar-test.iam.gserviceaccount.com"
    name   = "projects/pixelwar-test/serviceAccounts/tile-reader@pixelwar-test.iam.gserviceaccount.com"
  }
}

override_resource {
  target = module.overview_worker[0].google_service_account.runtime
  values = {
    email  = "overview-worker@pixelwar-test.iam.gserviceaccount.com"
    member = "serviceAccount:overview-worker@pixelwar-test.iam.gserviceaccount.com"
    name   = "projects/pixelwar-test/serviceAccounts/overview-worker@pixelwar-test.iam.gserviceaccount.com"
  }
}

variables {
  project_id              = "pixelwar-test"
  environment             = "dev"
  enable_discord_pipeline = true
  enable_discord_delivery = true
  enable_web_api          = true
}

run "disabled_by_default" {
  command = plan

  assert {
    condition = (
      length(module.overview_worker) == 0 && length(module.overview_tick) == 0 &&
      length(google_cloud_scheduler_job.overview_tick) == 0 &&
      length(google_storage_bucket_iam_member.tile_reader_overview) == 0 &&
      length(google_service_account_iam_member.tile_reader_signs_as_itself) == 0 &&
      !contains(keys(module.tile_reader[0].environment_variables), "OVERVIEW_BUCKET")
    )
    error_message = "No far-view worker, tick, grant or signing without opt-in."
  }
}

run "refuse_overview_without_web_api" {
  command = plan
  variables {
    enable_overview = true
    enable_web_api  = false
  }
  assert {
    condition     = length(module.overview_worker) == 0
    error_message = "The far view needs the tile-reader of the web API to be read."
  }
}

run "overview_wires_tick_worker_and_signed_urls" {
  command = apply
  variables { enable_overview = true }

  assert {
    condition = (
      google_cloud_scheduler_job.overview_tick[0].schedule == "* * * * *" &&
      google_cloud_scheduler_job.overview_tick[0].retry_config[0].retry_count == 0 &&
      google_cloud_scheduler_job.overview_tick[0].pubsub_target[0].topic_name == module.overview_tick[0].id &&
      module.overview_tick[0].name == "overview-tick" &&
      google_pubsub_topic_iam_member.overview_tick_scheduler_publisher[0].role == "roles/pubsub.publisher" &&
      google_pubsub_topic_iam_member.overview_tick_scheduler_publisher[0].member == "serviceAccount:service-123456789@gcp-sa-cloudscheduler.iam.gserviceaccount.com"
    )
    error_message = "Cloud Scheduler publishes one tick per minute on overview-tick, without retry."
  }
  assert {
    condition = (
      module.overview_worker[0].service_type == "worker" && module.overview_worker[0].max_instances == 1 &&
      module.overview_worker[0].concurrency == 1 &&
      module.overview_worker[0].environment_variables.OVERVIEW_BUCKET == "pixelwar-test-overview" &&
      module.overview_worker[0].environment_variables.OVERVIEW_TICK_SUBSCRIPTION == "projects/pixelwar-test/subscriptions/overview-worker" &&
      module.overview_worker_subscription[0].path == "projects/pixelwar-test/subscriptions/overview-worker" &&
      contains(keys(google_service_account_iam_member.push_token_creator), "overview_worker")
    )
    error_message = "One private worker, one cycle at a time, pushed by its own subscription."
  }
  assert {
    condition = (
      google_project_iam_member.overview_worker_firestore[0].role == "roles/datastore.viewer" &&
      google_storage_bucket_iam_member.overview_worker_images[0].bucket == "pixelwar-test-overview" &&
      google_storage_bucket_iam_member.overview_worker_images[0].role == "roles/storage.objectAdmin" &&
      google_storage_bucket_iam_member.overview_worker_images[0].member == "serviceAccount:overview-worker@pixelwar-test.iam.gserviceaccount.com"
    )
    error_message = "The worker only reads Firestore and only writes the overview bucket."
  }
  assert {
    condition = (
      google_storage_bucket_iam_member.tile_reader_overview[0].bucket == "pixelwar-test-overview" &&
      google_storage_bucket_iam_member.tile_reader_overview[0].role == "roles/storage.objectViewer" &&
      google_service_account_iam_member.tile_reader_signs_as_itself[0].service_account_id == "projects/pixelwar-test/serviceAccounts/tile-reader@pixelwar-test.iam.gserviceaccount.com" &&
      google_service_account_iam_member.tile_reader_signs_as_itself[0].member == "serviceAccount:tile-reader@pixelwar-test.iam.gserviceaccount.com" &&
      google_service_account_iam_member.tile_reader_signs_as_itself[0].role == "roles/iam.serviceAccountTokenCreator" &&
      module.tile_reader[0].environment_variables.OVERVIEW_BUCKET == "pixelwar-test-overview"
    )
    error_message = "The tile-reader reads the overview bucket only, and signs as itself only."
  }
  assert {
    condition = (
      length(google_storage_bucket.application["overview"].cors) == 1 &&
      google_storage_bucket.application["overview"].cors[0].origin == tolist(["https://frontend-123456789.europe-west1.run.app"]) &&
      google_storage_bucket.application["overview"].cors[0].method == tolist(["GET"]) &&
      length(google_storage_bucket.application["snapshots"].cors) == 0 &&
      google_storage_bucket.application["overview"].public_access_prevention == "enforced"
    )
    error_message = "Only the frontend origin may read far-view images from the browser; the bucket stays private."
  }
}

run "never_in_prd_without_the_dev_pipeline" {
  command = plan
  variables {
    environment     = "prd"
    enable_overview = true
  }
  assert {
    condition     = length(module.overview_worker) == 0
    error_message = "The far view follows the /draw pipeline, not created in prd for now."
  }
}
