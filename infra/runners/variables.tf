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
  description = "Environment name (dev or prd), selects the values files"
  type        = string
}

variable "state_bucket" {
  description = "Remote state bucket of this environment, holding the infra/foundation state"
  type        = string
}

variable "github_repository" {
  description = "GitHub repository the runners register to, as owner/name"
  type        = string
  default     = "Xekko1629/cloud-pixelwar-eliottmth"
}

variable "runner_sets" {
  description = <<-EOT
    Runner scale sets by size class. The key is the class (small, medium); the scale set
    name is also its runs-on label, published in the RUNNER_<CLASS> repository variable.
    small: fmt, lint, validate, plan. medium: terraform test, app builds, apply, destroy.
    Requests are sized for e2-standard-2 runner nodes (about 1.9 vCPU and 6 GiB allocatable):
    three small runners or one medium runner per node.
  EOT
  type = map(object({
    name         = string
    min_runners  = number
    max_runners  = number
    cpu          = string
    memory       = string
    memory_limit = string
  }))
  default = {
    small = {
      name         = "pixelwar-small"
      min_runners  = 0
      max_runners  = 6
      cpu          = "500m"
      memory       = "1Gi"
      memory_limit = "2Gi"
    }
    medium = {
      name         = "pixelwar-medium"
      min_runners  = 0
      max_runners  = 4
      cpu          = "1"
      memory       = "2Gi"
      memory_limit = "4Gi"
    }
  }

  validation {
    condition     = toset(keys(var.runner_sets)) == toset(["small", "medium"])
    error_message = "Declare exactly the small and medium runner classes used by the workflows."
  }

  validation {
    condition     = alltrue([for set in values(var.runner_sets) : set.min_runners <= set.max_runners && set.max_runners <= 6])
    error_message = "min_runners must not exceed max_runners, and max_runners must stay within the runners pool (6 nodes)."
  }
}

variable "arc_chart_version" {
  description = "Version of the Actions Runner Controller charts (controller and scale set must match)"
  type        = string
  default     = "0.14.2"
}

variable "external_secrets_chart_version" {
  description = "Version of the External Secrets Operator chart"
  type        = string
  default     = "2.12.0"
}
