mock_provider "google" {
  mock_data "google_project" {
    defaults = {
      number = "123456789012"
    }
  }
}

variables {
  project_id  = "pixelwar-test"
  environment = "dev"
}

run "persistent_serverless_prerequisites" {
  command = plan

  assert {
    condition     = google_artifact_registry_repository.containers.format == "DOCKER" && google_artifact_registry_repository.containers.repository_id == "pixelwar"
    error_message = "The bootstrap must create a Docker registry."
  }

  assert {
    condition     = google_artifact_registry_repository.containers.cleanup_policy_dry_run == true
    error_message = "Cleanup must initially be in dry-run mode to protect deployed releases."
  }

  assert {
    condition     = length(google_artifact_registry_repository.containers.cleanup_policies) == 2
    error_message = "Cleanup needs both an old-image deletion policy and a recent-image retention policy."
  }

  assert {
    condition = (
      google_storage_bucket.function_sources.name == "pixelwar-test-function-sources" &&
      google_storage_bucket.function_sources.public_access_prevention == "enforced" &&
      google_storage_bucket.function_sources.uniform_bucket_level_access == true &&
      google_storage_bucket.function_sources.force_destroy == false
    )
    error_message = "Function sources need a private, persistent bucket that Terraform cannot empty."
  }

  assert {
    condition = (
      google_storage_bucket.function_sources.versioning[0].enabled == true &&
      anytrue([for rule in google_storage_bucket.function_sources.lifecycle_rule : anytrue([for condition in rule.condition : condition.days_since_noncurrent_time == 30])])
    )
    error_message = "Keep noncurrent source generations long enough for the replay horizon, then expire them."
  }

  assert {
    condition = (
      google_service_account.function_builder.account_id == "function-builder" &&
      google_project_iam_member.function_builder_logging.role == "roles/logging.logWriter" &&
      google_storage_bucket_iam_member.function_builder_source_reader.role == "roles/storage.objectViewer" &&
      google_artifact_registry_repository_iam_member.function_builder_writer.role == "roles/artifactregistry.writer"
    )
    error_message = "Google's build needs a dedicated identity with logs, source read and repository write only."
  }

  assert {
    condition = (
      google_storage_bucket_iam_member.function_builder_source_reader.bucket == google_storage_bucket.function_sources.name &&
      google_artifact_registry_repository_iam_member.function_builder_writer.project == var.project_id &&
      google_artifact_registry_repository_iam_member.function_builder_writer.location == var.region
    )
    error_message = "Scope build permissions to the dedicated bucket and repository, not the whole project."
  }
}

run "planner_reads_function_sources" {
  command = plan

  assert {
    condition = (
      google_storage_bucket_iam_member.planner_source_reader.role == "roles/storage.objectViewer" &&
      google_storage_bucket_iam_member.planner_source_reader.member == "serviceAccount:github-planner@pixelwar-test.iam.gserviceaccount.com"
    )
    error_message = "The planner only reads the function sources bucket, to refresh the uploaded objects."
  }
}

run "builder_reads_only_regional_managed_source_objects" {
  command = plan

  override_resource {
    target          = google_service_account.function_builder
    override_during = plan
    values = {
      member = "serviceAccount:function-builder@pixelwar-test.iam.gserviceaccount.com"
    }
  }

  assert {
    condition = (
      google_project_iam_member.function_builder_managed_source_reader.project == "pixelwar-test" &&
      google_project_iam_member.function_builder_managed_source_reader.role == "roles/storage.objectViewer" &&
      google_project_iam_member.function_builder_managed_source_reader.member == "serviceAccount:function-builder@pixelwar-test.iam.gserviceaccount.com"
    )
    error_message = "Managed source access must belong only to the dedicated build identity in this project."
  }

  assert {
    condition = (
      google_project_iam_member.function_builder_managed_source_reader.condition[0].expression ==
      "resource.type == \"storage.googleapis.com/Object\" && resource.name.startsWith(\"projects/_/buckets/gcf-v2-sources-123456789012-europe-west1/objects/\")"
    )
    error_message = "Read only objects in the exact regional managed source bucket, not other buckets, bucket metadata or similarly prefixed bucket names."
  }
}

run "managed_source_scope_follows_project_number_and_region" {
  command = plan

  variables {
    project_id  = "pixelwar-other"
    environment = "prd"
    region      = "us-central1"
  }

  override_data {
    target = data.google_project.current
    values = {
      number = "987654321098"
    }
  }

  assert {
    condition = (
      google_project_iam_member.function_builder_managed_source_reader.project == "pixelwar-other" &&
      google_project_iam_member.function_builder_managed_source_reader.condition[0].expression ==
      "resource.type == \"storage.googleapis.com/Object\" && resource.name.startsWith(\"projects/_/buckets/gcf-v2-sources-987654321098-us-central1/objects/\")"
    )
    error_message = "Derive the bucket scope from the current project number and region, never from hardcoded dev values."
  }
}
