mock_provider "google" {}

variables {
  project_id  = "pixelwar-test"
  environment = "dev"
}

run "bootstrap_build_inputs" {
  command = plan

  assert {
    condition = output.function_build == {
      sources_bucket  = "pixelwar-test-function-sources"
      service_account = "projects/pixelwar-test/serviceAccounts/function-builder@pixelwar-test.iam.gserviceaccount.com"
      repository      = "projects/pixelwar-test/locations/europe-west1/repositories/pixelwar"
    }
    error_message = "Functions use the bootstrap bucket, build identity and repository, never the default accounts."
  }
}
