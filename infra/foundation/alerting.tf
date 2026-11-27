# Alert channel of the environment (OBS-01). The alert policies of the cluster and of the
# application (OBS-04) send to the channels of output.alert_notification_channels.

locals {
  # Writing one entry in this log fires the test alert (docs/observability.md#alertes).
  alert_test_log = "pixelwar-alert-test"
}

resource "google_monitoring_notification_channel" "email" {
  for_each = toset(var.alert_emails)

  display_name = "Pixel War ${var.environment} : ${each.value}"
  type         = "email"
  labels = {
    email_address = each.value
  }
  user_labels = {
    environment = var.environment
  }
}

# Checks that an alert reaches the channel: fires on any entry of the test log.
resource "google_monitoring_alert_policy" "channel_test" {
  display_name = "Test du canal d'alertes (${var.environment})"
  combiner     = "OR"
  severity     = "WARNING"

  conditions {
    display_name = "Entrée écrite dans le log ${local.alert_test_log}"

    condition_matched_log {
      filter = "logName=\"projects/${var.project_id}/logs/${local.alert_test_log}\""
    }
  }

  # Required for a log condition: at most one notification per 5 minutes.
  alert_strategy {
    auto_close = "1800s"

    notification_rate_limit {
      period = "300s"
    }
  }

  notification_channels = [for channel in google_monitoring_notification_channel.email : channel.name]

  documentation {
    mime_type = "text/markdown"
    subject   = "Pixel War ${var.environment} : alerte de test"
    content   = <<-EOT
      Alerte de test du canal (OBS-01). Elle part dès qu'une entrée est écrite dans le log
      `${local.alert_test_log}`, par exemple :

      `gcloud logging write ${local.alert_test_log} "test du canal" --severity=WARNING --project=${var.project_id}`

      Rien à faire : la recevoir prouve que les alertes arrivent. L'incident se ferme seul
      après 30 minutes.
    EOT
  }

  user_labels = {
    environment = var.environment
  }
}
