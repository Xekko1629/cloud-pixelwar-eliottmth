# Firestore database of the grid (ADR-0007), its composite indexes, index exemptions
# and TTL policies. No security rules: no client ever talks to Firestore (ADR-0013).
# Access is IAM only, granted to the runtime identity of each function that needs it:
# roles/datastore.user for the workers that write, roles/datastore.viewer for readers.
locals {
  firestore_database = "(default)"

  # Queries of the deltas feed (ADR-0003) and of the tiles of a region (tile-reader, ADR-0013).
  firestore_indexes = {
    tile_colors_by_region = {
      collection = "tile_colors"
      fields     = ["canvas_version", "region"]
    }
    deltas_by_region = {
      collection = "deltas"
      fields     = ["canvas_version", "region", "created_at"]
    }
    deltas_global = {
      collection = "deltas"
      fields     = ["canvas_version", "created_at"]
    }
  }

  # Large binary or map fields are never queried: excluding them from single-field
  # indexing saves storage and write cost. A ttl field also expires its documents.
  firestore_fields = {
    tile_colors_colors       = { collection = "tile_colors", field = "colors", ttl = false }
    tile_metadata_pixels     = { collection = "tile_metadata", field = "pixels", ttl = false }
    deltas_pixels            = { collection = "deltas", field = "pixels", ttl = false }
    deltas_expire_at         = { collection = "deltas", field = "expire_at", ttl = true }
    processed_events_expires = { collection = "processed_events", field = "expire_at", ttl = true }
  }
}

resource "google_firestore_database" "main" {
  project     = var.project_id
  name        = local.firestore_database
  location_id = var.region
  type        = "FIRESTORE_NATIVE"

  # Server libraries run transactions (DATA-02): pessimistic locking is the Native default.
  concurrency_mode                  = "PESSIMISTIC"
  app_engine_integration_mode       = "DISABLED"
  point_in_time_recovery_enablement = "POINT_IN_TIME_RECOVERY_DISABLED"

  # destroy must delete the database without any manual step (Definition of Done):
  # the provider default ABANDON would only forget it. With firestore_deletion_protection,
  # GCP refuses the delete and the destroy fails instead of losing the grid.
  # After a delete, the ID is only reusable after about 5 minutes: wait before re-applying.
  delete_protection_state = var.firestore_deletion_protection ? "DELETE_PROTECTION_ENABLED" : "DELETE_PROTECTION_DISABLED"
  deletion_policy         = "DELETE"
}

resource "google_firestore_index" "main" {
  for_each = local.firestore_indexes

  project     = var.project_id
  database    = google_firestore_database.main.name
  collection  = each.value.collection
  query_scope = "COLLECTION"

  dynamic "fields" {
    for_each = each.value.fields

    content {
      field_path = fields.value
      order      = "ASCENDING"
    }
  }
}

resource "google_firestore_field" "main" {
  for_each = local.firestore_fields

  project    = var.project_id
  database   = google_firestore_database.main.name
  collection = each.value.collection
  field      = each.value.field

  # Empty block: no single-field index on this field.
  index_config {}

  dynamic "ttl_config" {
    for_each = each.value.ttl ? [1] : []

    content {}
  }
}

output "firestore_database" {
  description = "Firestore database used by the functions (server libraries use (default) without configuration)"
  value       = google_firestore_database.main.name
}
