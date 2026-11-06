variable "project_id" {
  description = "GCP project the human access applies to"
  type        = string

  validation {
    condition     = contains(["cloud-pixelwar-dev", "cloud-pixelwar-prod"], var.project_id)
    error_message = "Project must be cloud-pixelwar-dev or cloud-pixelwar-prod."
  }
}

variable "developer_emails" {
  description = "Google user accounts allowed to read the two BOT-02 dev secrets (dev project only)"
  type        = set(string)
  default     = []

  validation {
    condition = alltrue([
      for email in var.developer_emails : can(regex("^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+[.][A-Za-z]{2,}$", email))
    ])
    error_message = "Provide valid user emails, without an IAM principal prefix."
  }
}

variable "team_editors" {
  description = "Google accounts of the team members granted roles/editor on the project"
  type        = set(string)

  validation {
    condition = length(var.team_editors) > 0 && alltrue([
      for email in var.team_editors : can(regex("^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+[.][A-Za-z]{2,}$", email))
    ])
    error_message = "Provide at least one valid user email, without an IAM principal prefix."
  }
}

variable "instructor_email" {
  description = "Google account of the instructor (subject §1.3: Editor on both projects, billing viewer)"
  type        = string
  default     = "jeremie@jjaouen.com"

  validation {
    condition     = can(regex("^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+[.][A-Za-z]{2,}$", var.instructor_email))
    error_message = "Provide a valid user email, without an IAM principal prefix."
  }
}

variable "billing_account" {
  description = "Billing account on which the instructor gets roles/billing.viewer (empty = not managed by this environment)"
  type        = string
  default     = ""

  validation {
    condition     = var.billing_account == "" || can(regex("^[0-9A-F]{6}-[0-9A-F]{6}-[0-9A-F]{6}$", var.billing_account))
    error_message = "Billing account must look like 0X0X0X-0X0X0X-0X0X0X, or be empty."
  }
}
