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

# The cluster is created by infra/foundation: its name and zone come from that stack's
# state, so renaming or moving it cannot silently break this stack.
data "terraform_remote_state" "foundation" {
  backend = "gcs"

  config = {
    bucket = var.state_bucket
    prefix = "foundation"
  }
}

data "google_container_cluster" "runners" {
  name     = data.terraform_remote_state.foundation.outputs.cluster_name
  location = data.terraform_remote_state.foundation.outputs.cluster_location

  lifecycle {
    precondition {
      condition     = data.terraform_remote_state.foundation.outputs.cluster_name != null
      error_message = "infra/foundation has no cluster in this environment (enable_cluster = false)."
    }
  }
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
