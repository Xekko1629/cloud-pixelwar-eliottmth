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

provider "google" {
  project = var.project_id
  region  = "europe-west1"

  # The Cloud Billing API needs a quota project with user credentials (prd, local apply).
  # The dev workflow identities have no serviceusage permission, so dev keeps the default.
  billing_project       = var.billing_account == "" ? null : var.project_id
  user_project_override = var.billing_account != ""
}
