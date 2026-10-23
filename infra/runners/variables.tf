variable "project_id" {
  description = "GCP project ID"
  type        = string
}

variable "region" {
  description = "Default GCP region"
  type        = string
  default     = "europe-west1"
}

variable "zone" {
  description = "Zone of the GKE cluster created by infra/foundation"
  type        = string
  default     = "europe-west1-b"
}

variable "environment" {
  description = "Environment name (dev or prd), selects the values files"
  type        = string
}

variable "cluster_name" {
  description = "Name of the GKE cluster created by infra/foundation"
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
  description = "Maximum concurrent runners (bounded by the runners node pool size)"
  type        = number
  default     = 3
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
