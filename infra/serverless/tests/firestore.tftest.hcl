mock_provider "google" {
  mock_resource "google_storage_bucket_object" {
    defaults = { generation = 1 }
  }
  mock_resource "google_firestore_database" {
    defaults = { name = "(default)" }
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

run "native_default_database" {
  command = plan

  assert {
    condition = (
      google_firestore_database.main.name == "(default)" &&
      google_firestore_database.main.type == "FIRESTORE_NATIVE" &&
      google_firestore_database.main.location_id == "europe-west1" &&
      google_firestore_database.main.app_engine_integration_mode == "DISABLED"
    )
    error_message = "One Native (default) database in the stack region, without App Engine."
  }
}

run "destroy_deletes_the_database" {
  command = plan

  assert {
    condition = (
      google_firestore_database.main.deletion_policy == "DELETE" &&
      google_firestore_database.main.delete_protection_state == "DELETE_PROTECTION_DISABLED"
    )
    error_message = "destroy must delete the database without a manual step (ABANDON would only forget it)."
  }
}

run "deletion_protection_blocks_destroy" {
  command = plan

  variables {
    firestore_deletion_protection = true
  }

  assert {
    condition     = google_firestore_database.main.delete_protection_state == "DELETE_PROTECTION_ENABLED"
    error_message = "With protection, GCP refuses the delete instead of Terraform silently abandoning the data."
  }
}

run "composite_indexes_of_the_queries" {
  command = plan

  assert {
    condition = (
      [for field in google_firestore_index.main["deltas_by_region"].fields : field.field_path] == ["canvas_version", "region", "created_at"] &&
      [for field in google_firestore_index.main["deltas_global"].fields : field.field_path] == ["canvas_version", "created_at"] &&
      [for field in google_firestore_index.main["tile_colors_by_region"].fields : field.field_path] == ["canvas_version", "region"] &&
      alltrue([for index in google_firestore_index.main : index.query_scope == "COLLECTION" && index.database == "(default)"])
    )
    error_message = "Declare the deltas feed and region tiles indexes of ADR-0003 and ADR-0013."
  }
}

run "ttl_and_index_exemptions" {
  command = plan

  assert {
    condition = toset([for key, field in google_firestore_field.main : key if length(field.ttl_config) == 1]) == toset([
      "deltas_expire_at",
      "processed_events_expires",
      "admin_events_expires",
    ])
    error_message = "Only deltas and deduplication records (draws and admin commands) expire; users/{uid} keeps the quota and last rejection."
  }

  assert {
    condition = (
      length(google_firestore_field.main) == 8 &&
      alltrue([for field in google_firestore_field.main : length(field.index_config) == 1 && length(field.index_config[0].indexes) == 0])
    )
    error_message = "Binary, map, TTL and deduplication fields are excluded from single-field indexing."
  }
}

run "database_output" {
  command = plan

  assert {
    condition     = output.firestore_database == "(default)"
    error_message = "Functions use the (default) database with the server libraries, without Firebase."
  }
}

run "global_config_is_created_complete" {
  command = apply

  assert {
    condition = (
      google_firestore_document.global_config.collection == "config" &&
      google_firestore_document.global_config.document_id == "global" &&
      google_firestore_document.global_config.database == "(default)" &&
      jsondecode(google_firestore_document.global_config.fields) == {
        paused                   = { booleanValue = false }
        canvas_version           = { integerValue = "1" }
        size                     = { nullValue = null }
        bounds                   = { nullValue = null }
        default_limit_per_minute = { integerValue = "20" }
      }
    )
    error_message = "config/global must hold every field DATA-02 requires: an incomplete document blocks every draw."
  }
}
