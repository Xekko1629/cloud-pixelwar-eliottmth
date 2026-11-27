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
  target = module.snapshot_worker[0].google_service_account.runtime
  values = {
    email  = "snapshot-worker@pixelwar-test.iam.gserviceaccount.com"
    member = "serviceAccount:snapshot-worker@pixelwar-test.iam.gserviceaccount.com"
    name   = "projects/pixelwar-test/serviceAccounts/snapshot-worker@pixelwar-test.iam.gserviceaccount.com"
  }
}
override_resource {
  target = module.snapshot_notifier[0].google_service_account.runtime
  values = {
    email  = "snapshot-notifier@pixelwar-test.iam.gserviceaccount.com"
    member = "serviceAccount:snapshot-notifier@pixelwar-test.iam.gserviceaccount.com"
    name   = "projects/pixelwar-test/serviceAccounts/snapshot-notifier@pixelwar-test.iam.gserviceaccount.com"
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

variables {
  project_id              = "pixelwar-test"
  environment             = "dev"
  enable_discord_pipeline = true
  enable_discord_delivery = true
  enable_discord_hello    = true
}

run "snapshot_follows_the_subject_chain" {
  command = apply

  assert {
    condition = (
      module.snapshot_requested[0].name == "snapshot-requested" &&
      module.command_worker[0].environment_variables.SNAPSHOT_REQUESTED_TOPIC == "snapshot-requested" &&
      module.snapshot_worker_subscription[0].path == "projects/pixelwar-test/subscriptions/snapshot-worker" &&
      module.snapshot_notifier_subscription[0].path == "projects/pixelwar-test/subscriptions/snapshot-notifier" &&
      google_storage_notification.snapshot_ready.object_name_prefix == "snapshots/"
    )
    error_message = "/snapshot → command-worker → snapshot-requested → worker → bucket → OBJECT_FINALIZE (images only) → notifier."
  }
  assert {
    condition = (
      google_storage_bucket_iam_member.snapshot_worker_objects[0].role == "roles/storage.objectCreator" &&
      google_storage_bucket_iam_member.snapshot_worker_objects[0].bucket == "pixelwar-test-snapshots" &&
      google_storage_bucket_iam_member.snapshot_worker_objects[0].member == "serviceAccount:snapshot-worker@pixelwar-test.iam.gserviceaccount.com" &&
      google_project_iam_member.snapshot_worker_firestore[0].role == "roles/datastore.viewer"
    )
    error_message = "The worker only creates objects in the snapshots bucket (no read, overwrite or delete) and only reads Firestore."
  }
  assert {
    condition = (
      google_storage_bucket_iam_member.snapshot_notifier_objects[0].role == "roles/storage.objectViewer" &&
      google_storage_bucket_iam_member.snapshot_notifier_objects[0].bucket == "pixelwar-test-snapshots" &&
      google_service_account_iam_member.snapshot_notifier_signs_as_itself[0].service_account_id == "projects/pixelwar-test/serviceAccounts/snapshot-notifier@pixelwar-test.iam.gserviceaccount.com" &&
      google_service_account_iam_member.snapshot_notifier_signs_as_itself[0].member == "serviceAccount:snapshot-notifier@pixelwar-test.iam.gserviceaccount.com" &&
      google_service_account_iam_member.snapshot_notifier_signs_as_itself[0].role == "roles/iam.serviceAccountTokenCreator"
    )
    error_message = "The notifier only reads the snapshots bucket and signs as itself only; it cannot delete."
  }
  assert {
    condition = (
      module.snapshot_worker[0].memory == "1Gi" && module.snapshot_worker[0].concurrency == 1 &&
      module.snapshot_worker[0].max_instances == 2 && module.snapshot_notifier[0].max_instances == 2
    )
    error_message = "One render at a time per instance, and 2 instances at most as cost ceiling."
  }
}

run "no_snapshot_function_without_the_pipeline" {
  command = plan
  variables {
    enable_discord_pipeline = false
    enable_discord_delivery = false
  }
  assert {
    condition = (
      length(module.snapshot_worker) == 0 && length(module.snapshot_notifier) == 0 &&
      length(google_storage_bucket_iam_member.snapshot_worker_objects) == 0 &&
      length(google_service_account_iam_member.snapshot_notifier_signs_as_itself) == 0
    )
    error_message = "No snapshot function nor grant without opt-in."
  }
}
