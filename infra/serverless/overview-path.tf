# Far view (DATA-05c, ADR-0007): a 256×256 image pyramid on 3 levels in the private overview
# bucket. Every minute, Cloud Scheduler publishes on overview-tick; the overview-worker reads
# the regions of the recent deltas (option B of 26/11: no consumer of pixel-processed),
# renders them from Firestore, then levels 2 and 3 from the images below. The tile-reader
# hands out 15-minute signed URLs of those images through the gateway (ADR-0013).
locals {
  overview_enabled = var.enable_overview && local.web_api_enabled && local.discord_delivery_enabled

  overview_tick_topic          = "overview-tick"
  overview_worker_subscription = "projects/${var.project_id}/subscriptions/overview-worker"
  overview_bucket              = google_storage_bucket.application["overview"].name
  # Publishes the Pub/Sub messages of the Cloud Scheduler jobs.
  scheduler_agent_member = "serviceAccount:service-${data.google_project.current.number}@gcp-sa-cloudscheduler.iam.gserviceaccount.com"
}

module "overview_tick" {
  source = "./modules/pubsub-topic"
  count  = local.overview_enabled ? 1 : 0

  project_id = var.project_id
  name       = local.overview_tick_topic
  labels     = local.labels
}

# The Cloud Scheduler service agent lives outside the project, so it is granted here rather
# than through the module's same-project publishers (as the Storage agent in storage.tf).
resource "google_pubsub_topic_iam_member" "overview_tick_scheduler_publisher" {
  count = local.overview_enabled ? 1 : 0

  project = var.project_id
  topic   = module.overview_tick[0].name
  role    = "roles/pubsub.publisher"
  member  = local.scheduler_agent_member
}

resource "google_cloud_scheduler_job" "overview_tick" {
  count = local.overview_enabled ? 1 : 0

  project     = var.project_id
  region      = var.region
  name        = "overview-tick"
  description = "Refreshes the far-view pyramid from the recent deltas (DATA-05c)"
  schedule    = var.overview_schedule
  time_zone   = "Etc/UTC"

  # A missed tick is not worth retrying: the next one rereads the same deltas.
  retry_config {
    retry_count = 0
  }

  pubsub_target {
    topic_name = module.overview_tick[0].id
    data       = base64encode("tick")
  }

  depends_on = [google_pubsub_topic_iam_member.overview_tick_scheduler_publisher]
}

module "overview_worker_source" {
  source = "./modules/function-source"
  count  = local.overview_enabled ? 1 : 0

  name       = "overview-worker"
  source_dir = "${path.root}/../../app/dist/functions/overview-worker"
  bucket     = local.function_build.sources_bucket
}

module "overview_worker" {
  source = "./modules/function"
  count  = local.overview_enabled ? 1 : 0

  project_id            = var.project_id
  region                = var.region
  name                  = "overview-worker"
  service_type          = "worker"
  source_archive        = module.overview_worker_source[0].source_archive
  entry_point           = "handleOverviewWorker"
  build_service_account = local.function_build.service_account
  build_repository      = local.function_build.repository
  labels                = local.labels
  # One cycle at a time: the state object of the bucket is the only cursor. At most 64 regions
  # per cycle keep it short; a late tick is acknowledged without work.
  min_instances   = 0
  max_instances   = 1
  concurrency     = 1
  memory          = "512Mi"
  timeout_seconds = 300
  environment_variables = {
    APP_ENV                    = var.environment
    GOOGLE_CLOUD_PROJECT       = var.project_id
    OVERVIEW_BUCKET            = local.overview_bucket
    OVERVIEW_TICK_SUBSCRIPTION = local.overview_worker_subscription
  }
}

# Reads config/global, deltas and tile_colors only: the cursor lives in the bucket, not in Firestore.
resource "google_project_iam_member" "overview_worker_firestore" {
  count = local.overview_enabled ? 1 : 0

  project = var.project_id
  role    = "roles/datastore.viewer"
  member  = module.overview_worker[0].service_account_member
}

# Writes and removes the images and its state object, in the overview bucket only.
resource "google_storage_bucket_iam_member" "overview_worker_images" {
  count = local.overview_enabled ? 1 : 0

  bucket = local.overview_bucket
  role   = "roles/storage.objectAdmin"
  member = module.overview_worker[0].service_account_member
}

module "overview_worker_subscription" {
  source = "./modules/push-subscription"
  count  = local.overview_enabled ? 1 : 0

  project_id                    = var.project_id
  name                          = "overview-worker"
  topic_id                      = module.overview_tick[0].id
  push_endpoint                 = module.overview_worker[0].uri
  invoker_service_account_email = module.overview_worker[0].invoker_service_account_email
  pubsub_agent_member           = local.pubsub_agent_member
  ack_deadline_seconds          = 330
  labels                        = local.labels

  depends_on = [google_service_account_iam_member.push_token_creator]
}

# tile-reader: reads the images to sign their URLs, in the overview bucket only.
resource "google_storage_bucket_iam_member" "tile_reader_overview" {
  count = local.overview_enabled ? 1 : 0

  bucket = local.overview_bucket
  role   = "roles/storage.objectViewer"
  member = module.tile_reader[0].service_account_member
}

# Signing without a key file goes through the IAM signBlob API, as the runtime identity
# itself: the grant is on its own service account, never on another one.
resource "google_service_account_iam_member" "tile_reader_signs_as_itself" {
  count = local.overview_enabled ? 1 : 0

  service_account_id = module.tile_reader[0].service_account_name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = module.tile_reader[0].service_account_member
}
