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
  description = "Environment name, must match the GitHub environment used by deploys (dev or prd)"
  type        = string

  validation {
    condition     = contains(["dev", "prd"], var.environment)
    error_message = "Environment must be dev or prd."
  }
}

variable "github_repository" {
  description = "GitHub repository allowed to authenticate, as owner/name"
  type        = string
  default     = "Xekko1629/cloud-pixelwar-eliottmth"
}

variable "deployer_roles" {
  description = "Project roles of the CI deployer (apply, destroy)"
  type        = set(string)
  default = [
    "roles/editor",
    "roles/resourcemanager.projectIamAdmin",
    "roles/container.admin", # Helm charts of the runners create CRDs and cluster RBAC
  ]
}

variable "planner_roles" {
  description = "Project roles of the CI planner (read-only PR plans)"
  type        = set(string)
  default = [
    "roles/viewer",
  ]
}

variable "deploy_reviewers" {
  description = "GitHub usernames whose approval is required before a deploy to this environment"
  type        = list(string)
  default     = []
}

variable "deploy_branch_patterns" {
  description = "Branches allowed to deploy to this environment (empty = any)"
  type        = list(string)
  default     = []
}

variable "deploy_tag_patterns" {
  description = "Tags allowed to deploy to this environment (empty = any)"
  type        = list(string)
  default     = []
}

variable "enable_runners" {
  description = "Create the GitHub App secret and identities of the self-hosted runners in this environment"
  type        = bool
  default     = false
}

variable "billing_account" {
  description = "Billing account ID the budget is attached to"
  type        = string
}

variable "budget_amount" {
  description = "Monthly budget of this project, in budget_currency"
  type        = number
  default     = 20
}

variable "budget_currency" {
  description = "Currency of the budget, must match the billing account currency"
  type        = string
  default     = "EUR"
}

variable "budget_alert_thresholds" {
  description = "Spent ratios of the budget that trigger an email alert"
  type        = list(number)
  default     = [0.5, 0.9, 1.0]
}
