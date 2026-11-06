terraform {
  required_version = ">= 1.9"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 7.0"
    }
  }

  backend "gcs" {}
}

# Applied locally with user credentials: the Cloud Billing API needs a quota project
provider "google" {
  project               = var.project_id
  region                = "europe-west1"
  billing_project       = var.project_id
  user_project_override = true
}
