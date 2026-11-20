variable "name" {
  description = "Function name, also the object prefix functions/<name>/"
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$", var.name))
    error_message = "Name must follow the function name rule (6 to 30 lowercase letters, digits or hyphens)."
  }
}

variable "source_dir" {
  description = "Built function directory (npm run build:functions): index.js and package.json"
  type        = string
}

variable "bucket" {
  description = "Private function sources bucket created by infra/bootstrap"
  type        = string
}
