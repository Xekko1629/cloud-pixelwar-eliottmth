# Remote state bucket of every stack of this environment. Created by hand before the
# first terraform init (subject C02 §5), then adopted here. It holds this stack's own
# state, so it must never be destroyed.
resource "google_storage_bucket" "tfstate" {
  name                        = var.state_bucket
  location                    = "EU"
  storage_class               = "STANDARD"
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false

  versioning {
    enabled = true
  }

  soft_delete_policy {
    retention_duration_seconds = 604800
  }

  lifecycle {
    prevent_destroy = true
  }
}

import {
  to = google_storage_bucket.tfstate
  id = var.state_bucket
}
