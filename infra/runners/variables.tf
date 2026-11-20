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

variable "runner_scale_set_name" {
  description = "Runner scale set name, also the label used in runs-on and the RUNNER_LABEL value"
  type        = string
  default     = "pixelwar-runners"
}

variable "min_runners" {
  description = "Idle runners kept registered (0 = runner pods only while jobs run)"
  type        = number
  default     = 0
}

variable "max_runners" {
  description = "Maximum concurrent runners (one per runners node, so at most the pool max_node_count)"
  type        = number
  default     = 6
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
