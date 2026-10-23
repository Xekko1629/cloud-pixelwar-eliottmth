terraform {
  required_version = ">= 1.9"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 7.0"
    }
    helm = {
      source  = "hashicorp/helm"
      version = "~> 3.3"
    }
    github = {
      source  = "integrations/github"
      version = "~> 6.13"
    }
  }

  backend "gcs" {}
}

provider "google" {
  project = var.project_id
  region  = var.region
}

# The cluster is created by infra/foundation and read here, so Helm is configured from existing data
data "google_container_cluster" "runners" {
  name     = var.cluster_name
  location = var.zone
}

data "google_client_config" "current" {}

provider "helm" {
  kubernetes = {
    host                   = "https://${data.google_container_cluster.runners.endpoint}"
    token                  = data.google_client_config.current.access_token
    cluster_ca_certificate = base64decode(data.google_container_cluster.runners.master_auth[0].cluster_ca_certificate)
  }
}

# Token read from the GITHUB_TOKEN environment variable (GitHub App installation token in CI)
provider "github" {
  owner = local.github_owner
}
