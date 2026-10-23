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

variable "cidr_block2" {
  description = "CIDR Variable"
  type        = string
}

variable "vpc_name2" {
  description = "VPC Name"
  type        = string
}
