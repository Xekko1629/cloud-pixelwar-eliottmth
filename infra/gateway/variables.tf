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

variable "warmup_schedule" {
  description = "Cron (UTC) of the gateway warm-up call; null disables it. API Gateway adds 3 to 5 s to the first requests after 15 to 20 min without traffic, beyond Discord's 3 s."
  type        = string
  default     = "* * * * *"
  nullable    = true
}
