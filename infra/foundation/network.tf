resource "google_compute_network" "main" {
  name                    = var.vpc_cluster_name
  auto_create_subnetworks = false
}

resource "google_compute_subnetwork" "main" {
  name          = "${var.vpc_cluster_name}-subnet"
  network       = google_compute_network.main.id
  ip_cidr_range = var.cidr_cluster_block
  region        = var.region

  secondary_ip_range {
    range_name    = "pods"
    ip_cidr_range = "10.4.0.0/14"
  }

  secondary_ip_range {
    range_name    = "services"
    ip_cidr_range = "10.8.0.0/20"
  }
}
