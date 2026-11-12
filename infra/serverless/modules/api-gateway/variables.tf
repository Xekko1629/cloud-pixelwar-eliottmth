variable "project_id" {
  description = "GCP project ID"
  type        = string
}

variable "region" {
  description = "Gateway region (must support API Gateway, e.g. europe-west1)"
  type        = string
}

variable "api_id" {
  description = "API and gateway identifier, also the prefix of the gateway service account (<api_id>-gateway)"
  type        = string
  default     = "pixelwar"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{3,20}[a-z0-9]$", var.api_id))
    error_message = "API ID must be 5 to 22 lowercase letters, digits or hyphens (the service account ID is limited to 30), start with a letter and end with a letter or digit."
  }
}

variable "labels" {
  description = "Extra labels for the API, its configurations and the gateway (provider default_labels also apply)"
  type        = map(string)
  default     = {}
}

variable "backends" {
  description = "Deployed proxy functions the gateway may call, by backend key: outputs name, uri and service_type of module function"
  type = map(object({
    function_name = string
    uri           = string
    service_type  = string
  }))
  default = {}

  # The gateway must never reach a worker: workers only accept Pub/Sub push (ADR-0002, ADR-0008).
  validation {
    condition     = alltrue([for backend in values(var.backends) : backend.service_type == "proxy"])
    error_message = "Gateway backends must be proxy functions; workers are only invoked by Pub/Sub."
  }

  validation {
    condition     = alltrue([for backend in values(var.backends) : startswith(backend.uri, "https://")])
    error_message = "Backend URIs must be the HTTPS URLs exported by module function."
  }
}

variable "routes" {
  description = "Route catalogue; a route is published only when its backend key is in var.backends"
  type = list(object({
    path             = string
    method           = string
    backend          = string
    operation_id     = string
    summary          = string
    deadline_seconds = optional(number, 15)
  }))

  validation {
    condition     = alltrue([for route in var.routes : contains(["get", "post", "put", "patch", "delete", "options"], route.method)])
    error_message = "Route methods must be lowercase HTTP verbs supported by OpenAPI 2.0."
  }

  validation {
    condition     = alltrue([for route in var.routes : startswith(route.path, "/")])
    error_message = "Route paths must start with a slash."
  }

  validation {
    condition     = length(distinct([for route in var.routes : route.operation_id])) == length(var.routes)
    error_message = "Operation IDs must be unique."
  }

  validation {
    condition     = length(distinct([for route in var.routes : "${route.method} ${route.path}"])) == length(var.routes)
    error_message = "A path and method pair can only be declared once."
  }
}
