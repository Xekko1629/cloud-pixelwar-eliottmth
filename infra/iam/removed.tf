# Former backend of infra/access dev (dev access workflow, removed). The access
# state now lives in the dev tfstate bucket; forget this bucket instead of
# destroying it, then delete it by hand once the state has been copied.
removed {
  from = google_storage_bucket.dev_access_state

  lifecycle {
    destroy = false
  }
}
