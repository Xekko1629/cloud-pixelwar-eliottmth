variable "project_id" {
  description = "GCP project ID"
  type        = string
}

variable "region" {
  description = "Default GCP region"
  type        = string
  default     = "europe-west1"
}

variable "vpc_cluster_name" {
  description = "Name of the VPC hosting the GKE cluster"
  type        = string
}

variable "cidr_cluster_block" {
  description = "Primary CIDR of the cluster subnet (nodes)"
  type        = string
}

variable "environment" {
  description = "Environment name (dev or prd)"
  type        = string
}

variable "zone" {
  description = "Zone of the GKE cluster"
  type        = string
  default     = "europe-west1-b"
}

variable "enable_cluster" {
  description = "Create the GKE cluster (CI runners) in this environment"
  type        = bool
  default     = false
}

variable "node_disk_size_gb" {
  description = "Boot disk of each GKE node; pd-balanced counts against the regional SSD_TOTAL_GB quota (250 GB)"
  type        = number
  default     = 30
}
