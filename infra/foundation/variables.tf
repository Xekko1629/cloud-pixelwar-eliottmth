variable "project_id" {
  description = "GCP project ID"
  type        = string
}

variable "region" {
  description = "Default GCP region"
  type        = string
  default     = "europe-west1"
}

variable "cidr_block" {
  description = "CIDR Variable"
  type        = string
}

variable "vpc_name" {
  description = "VPC Name"
  type        = string
}
