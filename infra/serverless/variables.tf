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

variable "enable_discord_hello" {
  description = "Enable the temporary signed Discord callback probe in dev only; has no effect in prd"
  type        = bool
  default     = false
}

variable "discord_hello_public_key_version" {
  description = "Explicit Secret Manager version of discord-public-key used by the dev probe"
  type        = string
  default     = "1"

  validation {
    condition     = can(regex("^[1-9][0-9]*$", var.discord_hello_public_key_version))
    error_message = "Select an explicit numeric secret version, not latest."
  }
}
