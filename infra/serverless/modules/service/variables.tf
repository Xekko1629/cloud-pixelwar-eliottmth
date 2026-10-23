variable "project_id" {
  description = "GCP project ID"
  type        = string
}

variable "region" {
  description = "Cloud Run region"
  type        = string
}

variable "name" {
  description = "Service and dedicated service account name (6 to 30 characters)"
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$", var.name))
    error_message = "Name must be 6 to 30 lowercase letters, digits or hyphens, start with a letter and end with a letter or digit."
  }
}

variable "image" {
  description = "Container image pinned to its immutable sha256 digest"
  type        = string

  validation {
    condition     = can(regex("^.+@sha256:[a-f0-9]{64}$", var.image))
    error_message = "Image must be pinned to a sha256 digest, not a mutable tag."
  }
}

variable "labels" {
  description = "Labels applied to the Cloud Run service"
  type        = map(string)
  default     = {}
}

variable "environment_variables" {
  description = "Non-secret environment variables (never put secret values here)"
  type        = map(string)
  default     = {}
}

variable "secrets" {
  description = "Environment variable name mapped to an existing secret ID in this project and an explicit version; never a secret value"
  type = map(object({
    secret  = string
    version = string
  }))
  default = {}
}

variable "min_instances" {
  description = "Minimum instances; zero allows scale-to-zero"
  type        = number
  default     = 0

  validation {
    condition     = var.min_instances >= 0 && floor(var.min_instances) == var.min_instances
    error_message = "Minimum instances must be a non-negative integer."
  }
}

variable "max_instances" {
  description = "Maximum instances; cap to protect downstream services and costs"
  type        = number
  default     = 5

  validation {
    condition     = var.max_instances > 0 && floor(var.max_instances) == var.max_instances
    error_message = "Maximum instances must be a positive integer."
  }
}

variable "concurrency" {
  description = "Maximum concurrent requests per instance; tune per worker"
  type        = number
  default     = 1

  validation {
    condition     = var.concurrency >= 1 && var.concurrency <= 1000 && floor(var.concurrency) == var.concurrency
    error_message = "Concurrency must be an integer between 1 and 1000."
  }
}

variable "timeout_seconds" {
  description = "Request timeout in seconds"
  type        = number
  default     = 60

  validation {
    condition     = var.timeout_seconds >= 1 && var.timeout_seconds <= 3600 && floor(var.timeout_seconds) == var.timeout_seconds
    error_message = "Timeout must be an integer between 1 and 3600 seconds."
  }
}

variable "cpu" {
  description = "CPU limit per instance"
  type        = string
  default     = "1"
}

variable "memory" {
  description = "Memory limit per instance; increase for image rendering workers"
  type        = string
  default     = "512Mi"
}

variable "deletion_protection" {
  description = "Protect the service from Terraform destruction; false for disposable stacks"
  type        = bool
  default     = false
}
