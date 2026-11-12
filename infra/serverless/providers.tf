terraform {
  required_version = ">= 1.9"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 7.0"
    }
    # API Gateway resources only exist in the beta provider.
    google-beta = {
      source  = "hashicorp/google-beta"
      version = "~> 7.0"
    }
    # Zips the built functions (modules/function-source).
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.7"
    }
  }

  backend "gcs" {}
}

provider "google" {
  project = var.project_id
  region  = var.region

  # Applied to every resource of this stack and of its modules that supports labels
  default_labels = local.labels
}

provider "google-beta" {
  project = var.project_id
  region  = var.region

  default_labels = local.labels
}
