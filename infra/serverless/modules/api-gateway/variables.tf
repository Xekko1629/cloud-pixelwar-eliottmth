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
    # session: the gateway validates a session JWT (ADR-0012) before calling the backend.
    # none: public at the gateway (Discord signature or OAuth login checked by the proxy).
    auth = optional(string, "session")
    # true: called from the browser, the gateway also publishes an OPTIONS preflight route.
    cors = optional(bool, false)
  }))

  validation {
    condition     = alltrue([for route in var.routes : contains(["get", "post", "put", "patch", "delete"], route.method)])
    error_message = "Route methods must be lowercase HTTP verbs; OPTIONS preflight routes are generated from cors = true."
  }

  validation {
    condition     = alltrue([for route in var.routes : contains(["session", "none"], route.auth)])
    error_message = "Route auth must be session or none."
  }

  validation {
    condition     = alltrue([for route in var.routes : startswith(route.path, "/")])
    error_message = "Route paths must start with a slash."
  }

  validation {
    # A template segment is a whole segment, e.g. /api/regions/{rx}/{ry}/tiles.
    condition     = alltrue([for route in var.routes : can(regex("^(/([A-Za-z0-9._-]+|\\{[a-z][a-z0-9_]*\\}))+$", route.path))])
    error_message = "Route paths are /-separated segments, each a literal or a whole {parameter} in lowercase."
  }

  validation {
    condition     = length(distinct([for route in var.routes : route.operation_id])) == length(var.routes)
    error_message = "Operation IDs must be unique."
  }

  validation {
    condition     = length(distinct([for route in var.routes : "${route.method} ${route.path}"])) == length(var.routes)
    error_message = "A path and method pair can only be declared once."
  }

  validation {
    condition = alltrue([
      for route in var.routes : route.auth == "session"
      if anytrue([for prefix in var.protected_path_prefixes : startswith(route.path, prefix)])
    ])
    error_message = "Routes under a protected prefix (/api/ by default) must require a session JWT."
  }

  validation {
    condition = alltrue([
      for path in distinct([for route in var.routes : route.path if route.cors]) :
      length(distinct([for route in var.routes : route.backend if route.path == path])) == 1
    ])
    error_message = "A CORS path must be served by a single backend, which answers its OPTIONS preflight."
  }
}

variable "protected_path_prefixes" {
  description = "Path prefixes whose routes must validate a session JWT at the gateway (subject section 3.4)"
  type        = list(string)
  default     = ["/api/"]
}

variable "session_signer_account_id" {
  description = "Account ID of the service account that signs the session JWTs (ADR-0012); its email is the token issuer"
  type        = string
  default     = "session-signer"
}

variable "session_audience" {
  description = "Audience (aud claim) of the session JWTs; null = the project ID, so a dev token is refused in prd"
  type        = string
  default     = null
}
