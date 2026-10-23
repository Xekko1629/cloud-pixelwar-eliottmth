variable "project_id" {
  description = "GCP project ID"
  type        = string
}

variable "region" {
  description = "Default GCP region"
  type        = string
  default     = "europe-west1"
}

variable "environment" {
  description = "Deployment environment"
  type        = string

  validation {
    condition     = contains(["dev", "prd"], var.environment)
    error_message = "Environment must be dev or prd."
  }
}
