resource "google_compute_network" "main" {
  name                    = var.vpc_name
  auto_create_subnetworks = false
}

resource "google_compute_subnetwork" "main" {
  name          = "${var.vpc_name}-subnet"
  network       = google_compute_network.main.id
  ip_cidr_range = var.cidr_block
  region        = var.region
}
