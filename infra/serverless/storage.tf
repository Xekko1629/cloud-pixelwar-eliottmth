# Application buckets (SRV-07). They hold derived images only, rebuilt from Firestore:
# the Destroy workflow deletes them with their objects (force_destroy). They are not the
# persistent function sources bucket of infra/bootstrap.
locals {
  snapshot_ready_topic = "snapshot-ready"

  # Shared hardening: IAM only (no ACL), never public.
  application_buckets = {
    # /snapshot PNGs (BOT-07a), shared through a signed URL (BOT-07b).
    # requests/<event_id>.json holds the interaction token for the notifier (BOT-07b): the
    # token lives 15 minutes, its request is deleted after one day.
    snapshots = { expire_after_days = var.snapshot_retention_days, requests_expire_after_days = 1 }
    # Low-resolution pyramid of the far view (DATA-05c): active images never expire.
    overview = { expire_after_days = null, requests_expire_after_days = null }
  }
}

resource "google_storage_bucket" "application" {
  for_each = local.application_buckets

  project                     = var.project_id
  name                        = "${var.project_id}-${each.key}"
  location                    = var.region
  storage_class               = "STANDARD"
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = true

  dynamic "lifecycle_rule" {
    for_each = each.value.expire_after_days == null ? [] : [each.value.expire_after_days]

    content {
      condition {
        age = lifecycle_rule.value
      }
      action {
        type = "Delete"
      }
    }
  }

  dynamic "lifecycle_rule" {
    for_each = each.value.requests_expire_after_days == null ? [] : [each.value.requests_expire_after_days]

    content {
      condition {
        age            = lifecycle_rule.value
        matches_prefix = ["requests/"]
      }
      action {
        type = "Delete"
      }
    }
  }
}

# Cloud Storage publishes the OBJECT_FINALIZE notifications of the snapshots bucket
# (ADR-0002). Native message, without the business envelope (docs/events.md, section 5).
module "snapshot_ready" {
  source = "./modules/pubsub-topic"

  project_id = var.project_id
  name       = local.snapshot_ready_topic
  labels     = local.labels
}

# The Cloud Storage service agent lives outside the project (gs-project-accounts), so it
# is granted here rather than through the module's same-project publishers.
data "google_storage_project_service_account" "main" {
  project = var.project_id
}

resource "google_pubsub_topic_iam_member" "snapshot_ready_storage_publisher" {
  project = var.project_id
  topic   = module.snapshot_ready.name
  role    = "roles/pubsub.publisher"
  member  = "serviceAccount:${data.google_storage_project_service_account.main.email_address}"
}

resource "google_storage_notification" "snapshot_ready" {
  bucket         = google_storage_bucket.application["snapshots"].name
  topic          = module.snapshot_ready.id
  payload_format = "JSON_API_V1"
  event_types    = ["OBJECT_FINALIZE"]
  # Images only: the request objects of the snapshot-worker must not wake the notifier.
  object_name_prefix = "snapshots/"

  # GCS checks the publisher grant when the notification is created.
  depends_on = [google_pubsub_topic_iam_member.snapshot_ready_storage_publisher]
}

output "storage_buckets" {
  description = "Application bucket names, for the workers' environment variables"
  value       = { for key, bucket in google_storage_bucket.application : key => bucket.name }
}

output "snapshot_ready_topic" {
  description = "Topic of the snapshots bucket OBJECT_FINALIZE notifications, consumed by snapshot-notifier"
  value       = module.snapshot_ready.name
}
