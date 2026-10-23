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

resource "google_compute_network" "sub" {
  name                    = var.vpc_name2
  auto_create_subnetworks = false
}

resource "google_compute_subnetwork" "sub" {
  name          = "${var.vpc_name2}-subnet"
  network       = google_compute_network.sub.id
  ip_cidr_range = var.cidr_block2
  region        = var.region
}
