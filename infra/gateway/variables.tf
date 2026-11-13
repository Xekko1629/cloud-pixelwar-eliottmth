variable "project_id" {
  description = "GCP project of the Gateway and its function backends"
  type        = string
}

variable "environment" {
  description = "Deployment environment"
  type        = string
  validation {
    condition     = contains(["dev", "prd"], var.environment)
    error_message = "Environment must be dev or prd."
  }
}

variable "region" {
  description = "Gateway and backend region"
  type        = string
  default     = "europe-west1"
}

variable "state_bucket" {
  description = "Existing environment state bucket; gateway reads serverless outputs only after its apply"
  type        = string
}
