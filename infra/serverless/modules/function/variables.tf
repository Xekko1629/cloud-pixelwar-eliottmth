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

variable "source_archive" {
  description = "CI-verified ZIP copied unchanged to each environment; content-addressed object and exact GCS generation, never latest"
  type = object({
    bucket     = string
    object     = string
    generation = string
    sha256     = string
  })
  nullable = false

  validation {
    condition = (
      can(regex("^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$", var.source_archive.bucket)) &&
      can(regex("^[a-f0-9]{64}$", var.source_archive.sha256)) &&
      can(regex("^[1-9][0-9]*$", var.source_archive.generation)) &&
      try(tonumber(var.source_archive.generation) <= 9223372036854775807, false) &&
      (var.source_archive.object == "${var.source_archive.sha256}.zip" ||
      endswith(var.source_archive.object, "/${var.source_archive.sha256}.zip"))
    )
    error_message = "Provide a bucket, <sha256>.zip object, lowercase SHA-256 and positive explicit generation."
  }
}

variable "entry_point" {
  description = "Exported Node.js HTTP handler in the deployment archive"
  type        = string

  validation {
    condition     = can(regex("^[A-Za-z_$][A-Za-z0-9_$]*$", var.entry_point))
    error_message = "entry_point must be a simple exported JavaScript handler identifier."
  }
}

variable "build_service_account" {
  description = "Existing dedicated build identity: projects/<project>/serviceAccounts/<email>; no default Compute/Cloud Build account"
  type        = string

  validation {
    condition = (
      can(regex("^projects/${var.project_id}/serviceAccounts/[a-z][a-z0-9-]{4,28}[a-z0-9]@${var.project_id}\\.iam\\.gserviceaccount\\.com$", var.build_service_account)) &&
      var.build_service_account != "projects/${var.project_id}/serviceAccounts/${var.name}@${var.project_id}.iam.gserviceaccount.com"
    )
    error_message = "Specify a dedicated build SA in this project, different from the function runtime SA."
  }
}

variable "build_repository" {
  description = "Existing same-project/same-region Artifact Registry repository used internally by Google's function build"
  type        = string

  validation {
    condition     = can(regex("^projects/${var.project_id}/locations/${var.region}/repositories/[a-z0-9][a-z0-9_-]*$", var.build_repository))
    error_message = "build_repository must be a full repository resource name in this project and region."
  }
}

variable "service_type" {
  description = "HTTP function role: worker uses internal ingress and Pub/Sub push OIDC; proxy accepts API Gateway with IAM (ADR-0008)"
  type        = string
  default     = "worker"

  validation {
    condition     = contains(["proxy", "worker"], var.service_type)
    error_message = "Service type must be proxy or worker."
  }
}

variable "labels" {
  description = "Labels applied to the Cloud Run function"
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

  validation {
    condition     = alltrue([for reference in values(var.secrets) : can(regex("^[1-9][0-9]*$", reference.version))])
    error_message = "Secret environment variables require explicit numeric versions, not latest."
  }
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
  description = "Map to function deletion_policy PREVENT when true, DELETE otherwise; false for disposable stacks"
  type        = bool
  default     = false
}
