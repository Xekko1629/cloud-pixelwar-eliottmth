variable "project_id" {
  description = "GCP project containing the topic and publisher runtime identities"
  type        = string
  nullable    = false
}

variable "name" {
  description = "Business event topic name, for example discord-command"
  type        = string
  nullable    = false

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,253}[a-z0-9]$", var.name)) && !startswith(var.name, "goog")
    error_message = "Use a 3-255 character lowercase kebab-case topic name, not the reserved goog prefix."
  }
}

variable "publishers" {
  description = "Stable logical keys mapped to existing same-project serviceAccount:<email> runtime members; never public or project-wide grants"
  type        = map(string)
  default     = {}
  nullable    = false

  validation {
    condition = alltrue([
      for member in values(var.publishers) :
      can(regex("^serviceAccount:[a-z][a-z0-9-]{4,28}[a-z0-9]@${var.project_id}\\.iam\\.gserviceaccount\\.com$", member))
    ])
    error_message = "Publishers must be dedicated service accounts in this project, not public, user, group or default Compute identities."
  }
}

variable "labels" {
  description = "Labels applied to the topic (in addition to provider defaults)"
  type        = map(string)
  default     = {}
  nullable    = false
}
