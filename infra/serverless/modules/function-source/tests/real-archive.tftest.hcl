# The real archive provider zips the fixture: checks the content-addressed object name
# without any GCP call (google is mocked).
mock_provider "google" {}

variables {
  name       = "hello-proxy"
  source_dir = "tests/fixture"
  bucket     = "pixelwar-test-function-sources"
}

run "content_addressed_object" {
  command = plan

  assert {
    condition     = can(regex("^functions/hello-proxy/[a-f0-9]{64}[.]zip$", google_storage_bucket_object.source.name))
    error_message = "The object name is the SHA-256 of the real archive."
  }

  assert {
    condition     = endswith(google_storage_bucket_object.source.name, "/${data.archive_file.source.output_sha256}.zip")
    error_message = "The object name and the SHA-256 given to module function are the same."
  }
}
