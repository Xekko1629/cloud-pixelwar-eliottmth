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
  description = "Project roles of the CI deployer (apply, destroy) in every environment. Never roles/editor nor roles/owner."
  type        = set(string)
  default = [
    # infra/bootstrap: sources bucket, image registry, build identity
    "roles/storage.admin",           # state objects, function sources bucket and objects
    "roles/artifactregistry.admin",  # pixelwar repository (function images, frontend image)
    "roles/iam.serviceAccountAdmin", # runtime, invoker, build and gateway identities
    "roles/iam.serviceAccountUser",  # actAs those identities when attaching them to a function or gateway
    # infra/serverless: functions, frontend service, broker, data, scheduled jobs
    "roles/cloudfunctions.admin",
    "roles/run.admin",
    "roles/pubsub.admin",
    "roles/datastore.owner", # Firestore database, indexes and TTL policies
    # infra/serverless realtime.tf (ADR-0015): Firestore Security Rules and the browser API key
    "roles/firebaserules.admin",
    "roles/serviceusage.apiKeysAdmin",
    "roles/cloudscheduler.admin",
    # infra/gateway: API, configs, gateway, and the managed service it enables
    "roles/apigateway.admin",
    "roles/serviceusage.serviceUsageAdmin",
    # Alert policies, dashboards and log-based metrics (OBS tickets)
    "roles/monitoring.editor",
    "roles/logging.configWriter",
    # infra/foundation: VPC and subnet (present in both environments)
    "roles/compute.networkAdmin",
  ]
}

variable "deployer_cluster_roles" {
  description = "Extra project roles of the CI deployer where enable_runners = true (GKE cluster and Helm releases of the runners)"
  type        = set(string)
  default = [
    "roles/container.admin", # cluster, node pools, and the CRDs and cluster RBAC of the Helm charts
  ]
}

variable "deployer_grantable_roles" {
  description = "The only roles the CI deployer may grant at project level (conditional projectIamAdmin)"
  type        = set(string)
  default = [
    # Runtime identities of the functions (modules/function): observability
    "roles/logging.logWriter",
    "roles/monitoring.metricWriter",
    "roles/cloudtrace.agent",
    "roles/telemetry.tracesWriter",
    # Runtime identities that read or write Firestore (workers, readers)
    "roles/datastore.user",
    "roles/datastore.viewer",
    # GKE nodes (infra/foundation)
    "roles/artifactregistry.reader",
    # function-builder reads the sources Cloud Functions stages in its own bucket
    # (infra/bootstrap, project grant restricted by a condition to those objects)
    "roles/storage.objectViewer",
  ]
}

variable "planner_roles" {
  description = "Project roles of the CI planner (read-only PR plans)"
  type        = set(string)
  default = [
    "roles/viewer",
    # Refresh of infra/serverless realtime.tf during PR plans: viewer cannot read the
    # key string of an API key, and the Security Rules have their own read role.
    "roles/firebaserules.viewer",
    "roles/serviceusage.apiKeysViewer",
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

variable "state_bucket" {
  description = "Remote state bucket of this environment, created by hand then imported"
  type        = string
}

variable "import_application_secrets" {
  description = "Adopt the application secrets that infra/serverless created before they moved here"
  type        = bool
  default     = false
}
