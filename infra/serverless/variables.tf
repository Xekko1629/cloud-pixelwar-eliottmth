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

variable "enable_discord_pipeline" {
  description = "Create the Discord proxy and diagnostic Pub/Sub pipeline in dev only; does not route Gateway traffic"
  type        = bool
  default     = false
}

variable "use_discord_proxy" {
  description = "Explicit dev Gateway backend selection, independent of resource creation; requires pipeline and authenticated delivery"
  type        = bool
  default     = false
}

variable "enable_discord_delivery" {
  description = "Enable dev authenticated push and forwarding IAM only after the invoker exists and its scoped CI permissions have been applied"
  type        = bool
  default     = false
}

variable "discord_proxy_public_key_version" {
  description = "Explicit numeric Secret Manager version of discord-public-key for the dev proxy"
  type        = string
  default     = "1"

  validation {
    condition     = can(regex("^[1-9][0-9]*$", var.discord_proxy_public_key_version))
    error_message = "Select an explicit numeric secret version, not latest."
  }
}

variable "discord_application_id_version" {
  description = "Explicit numeric Secret Manager version of discord-application-id for the dev proxy and workers"
  type        = string
  default     = "1"

  validation {
    condition     = can(regex("^[1-9][0-9]*$", var.discord_application_id_version))
    error_message = "Select an explicit numeric secret version, not latest."
  }
}

variable "admin_allowlist_version" {
  description = "Explicit numeric Secret Manager version of admin-allowlist ({\"user_ids\": [], \"role_ids\": []}) for the command-worker"
  type        = string
  default     = "1"

  validation {
    condition     = can(regex("^[1-9][0-9]*$", var.admin_allowlist_version))
    error_message = "Select an explicit numeric secret version, not latest."
  }
}

variable "enable_web_api" {
  description = "Deploy the web-proxy and tile-reader and export them to the gateway (dev only for now: needs the /draw pipeline)"
  type        = bool
  default     = false
}

variable "snapshot_retention_days" {
  description = "Age in days after which /snapshot images are deleted; a V4 signed URL lives 7 days at most"
  type        = number
  default     = 7

  validation {
    condition     = var.snapshot_retention_days >= 1 && var.snapshot_retention_days <= 30 && floor(var.snapshot_retention_days) == var.snapshot_retention_days
    error_message = "Keep snapshots between 1 and 30 whole days."
  }
}

variable "firestore_deletion_protection" {
  description = "Refuse the deletion of the Firestore database (destroy then fails); false keeps destroy fully automatic"
  type        = bool
  default     = false
}

variable "enable_auth_proxy" {
  description = "Deploy the auth-proxy (Discord login and session JWTs) and publish its routes on the gateway"
  type        = bool
  default     = false
}

variable "discord_oauth_client_secret_version" {
  description = "Explicit numeric Secret Manager version of discord-oauth-client-secret for the auth-proxy"
  type        = string
  default     = "1"

  validation {
    condition     = can(regex("^[1-9][0-9]*$", var.discord_oauth_client_secret_version))
    error_message = "Select an explicit numeric secret version, not latest."
  }
}

variable "enable_realtime" {
  description = "Security Rules and browser API key of the Firestore listeners of the frontend (ADR-0015); needs the firebaserules and apikeys APIs of infra/iam"
  type        = bool
  default     = false
}

variable "realtime_extra_referrers" {
  description = "Extra pages allowed to use the browser API key besides the frontend, e.g. a local Vite server in dev"
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for referrer in var.realtime_extra_referrers : can(regex("^(https://[a-z0-9.-]+|http://(localhost|127[.]0[.]0[.]1)(:[0-9]+)?)/[*]$", referrer))])
    error_message = "Each referrer is https://<host>/* or a local http://localhost:<port>/*."
  }
}
