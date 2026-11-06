# Budget alerts on this project, emailed to the admins and users of the billing account (the 3 team members)

data "google_project" "current" {}

resource "google_billing_budget" "project" {
  provider = google.billing

  billing_account = var.billing_account
  display_name    = "cloud-pixelwar-${var.environment}"

  budget_filter {
    projects = ["projects/${data.google_project.current.number}"]
  }

  amount {
    specified_amount {
      currency_code = var.budget_currency
      units         = tostring(var.budget_amount)
    }
  }

  dynamic "threshold_rules" {
    for_each = var.budget_alert_thresholds

    content {
      threshold_percent = threshold_rules.value
    }
  }

  depends_on = [google_project_service.apis]
}
