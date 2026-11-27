# /snapshot (BOT-07a/b, subject §5.4): command-worker → snapshot-requested → snapshot-worker,
# which renders the painted area (DATA-05b) into the private snapshots bucket; Cloud Storage
# then reports the new object (OBJECT_FINALIZE → snapshot-ready, storage.tf) to the
# snapshot-notifier, which posts a signed URL in the deferred answer. Same flags as /get.
#
# The interaction token goes in requests/<event_id>.json, never in the image metadata (that
# metadata is returned with every download, signed URL included). Only these two functions
# can read the bucket.
locals {
  snapshot_requested_topic       = "snapshot-requested"
  snapshot_worker_subscription   = "projects/${var.project_id}/subscriptions/snapshot-worker"
  snapshot_notifier_subscription = "projects/${var.project_id}/subscriptions/snapshot-notifier"
  snapshots_bucket               = google_storage_bucket.application["snapshots"].name
}

module "snapshot_requested" {
  source = "./modules/pubsub-topic"
  count  = local.discord_pipeline_enabled ? 1 : 0

  project_id = var.project_id
  name       = local.snapshot_requested_topic
  labels     = local.labels
  publishers = { command_worker = module.command_worker[0].service_account_member }
}

module "snapshot_worker_source" {
  source = "./modules/function-source"
  count  = local.discord_pipeline_enabled ? 1 : 0

  name       = "snapshot-worker"
  source_dir = "${path.root}/../../app/dist/functions/snapshot-worker"
  bucket     = local.function_build.sources_bucket
}

module "snapshot_worker" {
  source = "./modules/function"
  count  = local.discord_pipeline_enabled ? 1 : 0

  project_id            = var.project_id
  region                = var.region
  name                  = "snapshot-worker"
  service_type          = "worker"
  source_archive        = module.snapshot_worker_source[0].source_archive
  entry_point           = "handleSnapshotWorker"
  build_service_account = local.function_build.service_account
  build_repository      = local.function_build.repository
  labels                = local.labels
  # Same profile as the render-worker: one render at a time, up to 4096 × 4096 indices
  # (16 MiB) and its PNG (SNAPSHOT_RENDER_OPTIONS), 2 instances as cost ceiling.
  min_instances   = 0
  max_instances   = 2
  concurrency     = 1
  memory          = "1Gi"
  timeout_seconds = 300
  environment_variables = {
    APP_ENV                         = var.environment
    GOOGLE_CLOUD_PROJECT            = var.project_id
    SNAPSHOT_REQUESTED_SUBSCRIPTION = local.snapshot_worker_subscription
    SNAPSHOTS_BUCKET                = local.snapshots_bucket
  }
  secrets = {
    DISCORD_APPLICATION_ID = { secret = "discord-application-id", version = var.discord_application_id_version }
  }
}

# Reads config/global and tile_colors only.
resource "google_project_iam_member" "snapshot_worker_firestore" {
  count = local.discord_pipeline_enabled ? 1 : 0

  project = var.project_id
  role    = "roles/datastore.viewer"
  member  = module.snapshot_worker[0].service_account_member
}

# Creates the request and the image, in the snapshots bucket only; cannot read, overwrite or delete.
resource "google_storage_bucket_iam_member" "snapshot_worker_objects" {
  count = local.discord_pipeline_enabled ? 1 : 0

  bucket = local.snapshots_bucket
  role   = "roles/storage.objectCreator"
  member = module.snapshot_worker[0].service_account_member
}

module "snapshot_worker_subscription" {
  source = "./modules/push-subscription"
  count  = local.discord_delivery_enabled ? 1 : 0

  project_id                    = var.project_id
  name                          = "snapshot-worker"
  topic_id                      = module.snapshot_requested[0].id
  push_endpoint                 = module.snapshot_worker[0].uri
  invoker_service_account_email = module.snapshot_worker[0].invoker_service_account_email
  pubsub_agent_member           = local.pubsub_agent_member
  ack_deadline_seconds          = 330
  labels                        = local.labels

  depends_on = [google_service_account_iam_member.push_token_creator]
}

module "snapshot_notifier_source" {
  source = "./modules/function-source"
  count  = local.discord_pipeline_enabled ? 1 : 0

  name       = "snapshot-notifier"
  source_dir = "${path.root}/../../app/dist/functions/snapshot-notifier"
  bucket     = local.function_build.sources_bucket
}

module "snapshot_notifier" {
  source = "./modules/function"
  count  = local.discord_pipeline_enabled ? 1 : 0

  project_id            = var.project_id
  region                = var.region
  name                  = "snapshot-notifier"
  service_type          = "worker"
  source_archive        = module.snapshot_notifier_source[0].source_archive
  entry_point           = "handleSnapshotNotifier"
  build_service_account = local.function_build.service_account
  build_repository      = local.function_build.repository
  labels                = local.labels
  # Network-bound (one read, one signature, one Discord edit): several at a time.
  min_instances   = 0
  max_instances   = 2
  concurrency     = 8
  timeout_seconds = 30
  environment_variables = {
    APP_ENV                     = var.environment
    GOOGLE_CLOUD_PROJECT        = var.project_id
    SNAPSHOT_READY_SUBSCRIPTION = local.snapshot_notifier_subscription
    SNAPSHOTS_BUCKET            = local.snapshots_bucket
  }
  secrets = {
    DISCORD_APPLICATION_ID = { secret = "discord-application-id", version = var.discord_application_id_version }
  }
}

# Reads the request objects and the images, in the snapshots bucket only.
resource "google_storage_bucket_iam_member" "snapshot_notifier_objects" {
  count = local.discord_pipeline_enabled ? 1 : 0

  bucket = local.snapshots_bucket
  role   = "roles/storage.objectViewer"
  member = module.snapshot_notifier[0].service_account_member
}

# Signing without a key file goes through the IAM signBlob API, as the runtime identity
# itself: the grant is on its own service account, never on another one.
resource "google_service_account_iam_member" "snapshot_notifier_signs_as_itself" {
  count = local.discord_pipeline_enabled ? 1 : 0

  service_account_id = module.snapshot_notifier[0].service_account_name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = module.snapshot_notifier[0].service_account_member
}

module "snapshot_notifier_subscription" {
  source = "./modules/push-subscription"
  count  = local.discord_delivery_enabled ? 1 : 0

  project_id                    = var.project_id
  name                          = "snapshot-notifier"
  topic_id                      = module.snapshot_ready.id
  push_endpoint                 = module.snapshot_notifier[0].uri
  invoker_service_account_email = module.snapshot_notifier[0].invoker_service_account_email
  pubsub_agent_member           = local.pubsub_agent_member
  ack_deadline_seconds          = 60
  labels                        = local.labels

  depends_on = [google_service_account_iam_member.push_token_creator]
}
