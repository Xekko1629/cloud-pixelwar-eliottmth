# GKE cluster hosting the self-hosted GitHub runners.
# Only created where enable_cluster = true (prd). The GKE API is enabled by infra/iam.

# The API used to be enabled here; infra/iam owns it now. Forget it, never disable it.
removed {
  from = google_project_service.container

  lifecycle {
    destroy = false
  }
}

resource "google_service_account" "gke_nodes" {
  count = var.enable_cluster ? 1 : 0

  account_id   = "gke-nodes"
  display_name = "GKE nodes"
}

resource "google_project_iam_member" "gke_nodes" {
  for_each = var.enable_cluster ? toset([
    "roles/logging.logWriter",       # send container logs
    "roles/monitoring.metricWriter", # send metrics
    "roles/artifactregistry.reader", # pull Docker images
  ]) : toset([])

  project = var.project_id
  role    = each.value
  member  = google_service_account.gke_nodes[0].member
}

resource "google_container_cluster" "main" {
  count = var.enable_cluster ? 1 : 0

  name     = "pixelwar-${var.environment}"
  location = var.zone

  network    = google_compute_network.main.id
  subnetwork = google_compute_subnetwork.main.id

  remove_default_node_pool = true
  initial_node_count       = 1
  deletion_protection      = false

  ip_allocation_policy {
    cluster_secondary_range_name  = "pods"
    services_secondary_range_name = "services"
  }

  workload_identity_config {
    workload_pool = "${var.project_id}.svc.id.goog"
  }

  release_channel {
    channel = "REGULAR"
  }

  cluster_autoscaling {
    autoscaling_profile = "BALANCED"
  }
}

# Always-on pool for system pods and the runner controller
resource "google_container_node_pool" "system" {
  count = var.enable_cluster ? 1 : 0

  name     = "system"
  cluster  = google_container_cluster.main[0].id
  location = google_container_cluster.main[0].location

  autoscaling {
    min_node_count = 1
    max_node_count = 2
  }

  node_config {
    machine_type    = "e2-medium"
    disk_type       = "pd-balanced"
    disk_size_gb    = var.node_disk_size_gb
    spot            = true
    service_account = google_service_account.gke_nodes[0].email
    oauth_scopes    = ["https://www.googleapis.com/auth/cloud-platform"]

    workload_metadata_config {
      mode = "GKE_METADATA"
    }
  }
}

# Runner pods only (taint), scaled to zero when no job runs; not spot so applies are never interrupted
resource "google_container_node_pool" "runners" {
  count = var.enable_cluster ? 1 : 0

  name     = "runners"
  cluster  = google_container_cluster.main[0].id
  location = google_container_cluster.main[0].location

  autoscaling {
    min_node_count = 0
    # 6 x 2 vCPU + 2 shared-core system nodes (1 quota vCPU each) = 14 of the 16 vCPU CPUS_ALL_REGIONS quota,
    # leaving room for the surge node of an upgrade; see docs/gcp.md
    max_node_count = 6
  }

  node_config {
    machine_type    = "e2-standard-2"
    disk_type       = "pd-balanced"
    disk_size_gb    = var.node_disk_size_gb
    spot            = false
    service_account = google_service_account.gke_nodes[0].email
    oauth_scopes    = ["https://www.googleapis.com/auth/cloud-platform"]

    labels = {
      pool = "runners"
    }

    taint {
      key    = "dedicated"
      value  = "runners"
      effect = "NO_SCHEDULE"
    }

    workload_metadata_config {
      mode = "GKE_METADATA"
    }
  }
}
