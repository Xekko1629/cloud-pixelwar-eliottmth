variable "project_id" {
  description = "GCP project of the frontend service"
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
  description = "Region of the Cloud Run service and of the pixelwar image repository"
  type        = string
  default     = "europe-west1"
}

variable "state_bucket" {
  description = "Environment state bucket; the frontend reads the gateway URL from the gateway state"
  type        = string
}

variable "image" {
  description = <<-EOT
    Frontend image, by digest: <region>-docker.pkg.dev/<project>/pixelwar/frontend@sha256:<digest>.
    Set by the CI (TF_VAR_image) after pushing the image built for the commit. null (destroy,
    local plan without image) declares no service.
  EOT
  type        = string
  default     = null

  validation {
    condition     = var.image == null || can(regex("^[a-z0-9-]+-docker\\.pkg\\.dev/[a-z][a-z0-9-]+/pixelwar/frontend@sha256:[a-f0-9]{64}$", var.image))
    error_message = "Reference the frontend image of the pixelwar repository by digest (@sha256:...), never by tag."
  }
}

variable "max_instances" {
  description = "Maximum number of frontend instances"
  type        = number
  default     = 2

  validation {
    condition     = var.max_instances >= 1 && var.max_instances <= 10
    error_message = "max_instances must be between 1 and 10."
  }
}

variable "realtime_url" {
  description = "Origin of the realtime SSE service (ADR-0013); empty until DRAW-06"
  type        = string
  default     = ""

  validation {
    condition     = var.realtime_url == "" || can(regex("^https://[A-Za-z0-9.-]+$", var.realtime_url))
    error_message = "realtime_url must be an https origin without path."
  }
}

variable "discord_client_id" {
  description = "Public Discord OAuth2 client id of this environment; empty until WEB-02b"
  type        = string
  default     = ""

  validation {
    condition     = var.discord_client_id == "" || can(regex("^[1-9][0-9]{0,19}$", var.discord_client_id))
    error_message = "discord_client_id must be a Discord snowflake."
  }
}
