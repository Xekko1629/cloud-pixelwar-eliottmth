mock_provider "google" {
  mock_resource "google_storage_bucket_object" {
    defaults = { generation = 1 }
  }
  mock_resource "google_firestore_database" {
    defaults = { name = "(default)" }
  }
  mock_resource "google_pubsub_topic" {
    defaults = { id = "projects/pixelwar-test/topics/snapshot-ready" }
  }
  mock_data "google_storage_project_service_account" {
    defaults = { email_address = "service-123456789012@gs-project-accounts.iam.gserviceaccount.com" }
  }
}
mock_provider "archive" {
  mock_data "archive_file" {
    defaults = { output_sha256 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }
  }
}
mock_provider "google-beta" {}

variables {
  project_id  = "pixelwar-test"
  environment = "dev"
}

run "private_destroyable_buckets" {
  command = plan

  assert {
    condition = (
      keys(google_storage_bucket.application) == ["overview", "snapshots"] &&
      google_storage_bucket.application["snapshots"].name == "pixelwar-test-snapshots" &&
      google_storage_bucket.application["overview"].name == "pixelwar-test-overview" &&
      alltrue([
        for bucket in google_storage_bucket.application :
        bucket.uniform_bucket_level_access &&
        bucket.public_access_prevention == "enforced" &&
        bucket.force_destroy &&
        bucket.location == "europe-west1"
      ])
    )
    error_message = "Both buckets are private, IAM-only, in the stack region, and deleted with their objects by destroy."
  }
}

run "only_snapshots_expire" {
  command = plan

  assert {
    condition = (
      length(google_storage_bucket.application["overview"].lifecycle_rule) == 0 &&
      length(google_storage_bucket.application["snapshots"].lifecycle_rule) == 1 &&
      one(google_storage_bucket.application["snapshots"].lifecycle_rule[0].condition).age == 7 &&
      one(google_storage_bucket.application["snapshots"].lifecycle_rule[0].action).type == "Delete"
    )
    error_message = "Snapshots expire after 7 days by default; active overview images never expire."
  }
}

run "snapshot_retention_is_configurable" {
  command = plan

  variables {
    snapshot_retention_days = 3
  }

  assert {
    condition     = one(google_storage_bucket.application["snapshots"].lifecycle_rule[0].condition).age == 3
    error_message = "snapshot_retention_days sets the expiration age."
  }
}

run "snapshot_retention_is_bounded" {
  command = plan

  variables {
    snapshot_retention_days = 0
  }

  expect_failures = [var.snapshot_retention_days]
}

run "finalize_notification_to_snapshot_ready" {
  command = plan

  assert {
    condition = (
      module.snapshot_ready.name == "snapshot-ready" &&
      google_storage_notification.snapshot_ready.bucket == "pixelwar-test-snapshots" &&
      google_storage_notification.snapshot_ready.event_types == toset(["OBJECT_FINALIZE"]) &&
      google_storage_notification.snapshot_ready.payload_format == "JSON_API_V1"
    )
    error_message = "Only OBJECT_FINALIZE of the snapshots bucket is published, with the JSON object resource."
  }
}

run "storage_agent_publishes_on_the_topic_only" {
  command = plan

  assert {
    condition = (
      google_pubsub_topic_iam_member.snapshot_ready_storage_publisher.topic == "snapshot-ready" &&
      google_pubsub_topic_iam_member.snapshot_ready_storage_publisher.role == "roles/pubsub.publisher" &&
      google_pubsub_topic_iam_member.snapshot_ready_storage_publisher.member == "serviceAccount:service-123456789012@gs-project-accounts.iam.gserviceaccount.com"
    )
    error_message = "The Cloud Storage service agent gets publisher on snapshot-ready, nothing wider."
  }
}

run "same_resources_in_prd" {
  command = plan

  variables {
    project_id  = "pixelwar-prd"
    environment = "prd"
  }

  assert {
    condition = (
      google_storage_bucket.application["snapshots"].name == "pixelwar-prd-snapshots" &&
      google_storage_bucket.application["overview"].force_destroy
    )
    error_message = "prd has the same buckets, also destroyable by the Destroy workflow."
  }
}
