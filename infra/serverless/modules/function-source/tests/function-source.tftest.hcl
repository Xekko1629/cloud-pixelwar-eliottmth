mock_provider "google" {}
mock_provider "archive" {
  mock_data "archive_file" {
    defaults = {
      output_sha256 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    }
  }
}

variables {
  name       = "hello-proxy"
  source_dir = "tests/fixture"
  bucket     = "pixelwar-test-function-sources"
}

run "upload_built_function" {
  command = plan

  assert {
    condition     = data.archive_file.source.source_dir == "tests/fixture" && data.archive_file.source.output_file_mode == "0644"
    error_message = "The built directory is zipped with fixed file modes."
  }

  assert {
    condition = (
      google_storage_bucket_object.source.bucket == "pixelwar-test-function-sources" &&
      google_storage_bucket_object.source.name == "functions/hello-proxy/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.zip" &&
      google_storage_bucket_object.source.content_type == "application/zip"
    )
    error_message = "The archive goes to the sources bucket under functions/<name>/<sha256>.zip."
  }

  assert {
    condition = (
      output.source_archive.object == "functions/hello-proxy/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.zip" &&
      output.source_archive.sha256 == "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" &&
      output.source_archive.bucket == "pixelwar-test-function-sources"
    )
    error_message = "The output matches the source_archive input of module function."
  }
}

run "reject_invalid_name" {
  command = plan

  variables {
    name = "Hello"
  }

  expect_failures = [var.name]
}
