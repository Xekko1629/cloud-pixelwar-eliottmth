variable "project_id" {
  description = "This initial access scope is deliberately restricted to the dev project."
  type        = string

  validation {
    condition     = var.project_id == "cloud-pixelwar-dev"
    error_message = "This stack currently manages only cloud-pixelwar-dev; prd needs a separate reviewed design."
  }
}

variable "developer_emails" {
  description = "Google user accounts allowed to read the two BOT-02 dev secrets."
  type        = set(string)

  validation {
    condition = length(var.developer_emails) > 0 && alltrue([
      for email in var.developer_emails : can(regex("^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}$", email))
    ])
    error_message = "Provide at least one valid user email, without an IAM principal prefix."
  }
}
