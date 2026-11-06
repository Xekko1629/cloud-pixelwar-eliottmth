variable "project_id" {
  description = "GCP project ID"
  type        = string
}

variable "region" {
  description = "Artifact Registry region"
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

variable "image_versions_to_keep" {
  description = "Number of most recent images to keep per package"
  type        = number
  default     = 10

  validation {
    condition     = var.image_versions_to_keep >= 1 && floor(var.image_versions_to_keep) == var.image_versions_to_keep
    error_message = "Keep at least one image version; the count must be an integer."
  }
}
