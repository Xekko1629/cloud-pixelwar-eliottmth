# SRV-05 / docs/events.md 7.3: a message in any DLQ is a lost action (a pixel, a command)
# that nobody retries. One policy covers every <subscription>-dlq-inspect subscription of
# modules/push-subscription; each subscription opens its own incident. Messages stay 7 days
# in the inspection subscription, so the incident stays open until someone handles them.
resource "google_monitoring_alert_policy" "dlq_not_empty" {
  count = local.discord_delivery_enabled ? 1 : 0

  project               = var.project_id
  display_name          = "DLQ non vide (${var.environment})"
  combiner              = "OR"
  severity              = "WARNING"
  notification_channels = var.alert_notification_channels
  user_labels           = local.labels

  conditions {
    display_name = "Message en attente dans une DLQ"
    condition_threshold {
      filter = join(" AND ", [
        "resource.type = \"pubsub_subscription\"",
        "metric.type = \"pubsub.googleapis.com/subscription/num_undelivered_messages\"",
        "resource.labels.subscription_id = monitoring.regex.full_match(\".*-dlq-inspect\")",
      ])
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "0s"
      aggregations {
        alignment_period   = "60s"
        per_series_aligner = "ALIGN_MAX"
      }
      trigger { count = 1 }
    }
  }

  documentation {
    mime_type = "text/markdown"
    subject   = "Pixelwar ${var.environment} : message en DLQ"
    content   = "Un message a épuisé ses tentatives de livraison. Inspecter l'abonnement `<abonnement>-dlq-inspect` indiqué par l'incident, puis rejouer ou acquitter : docs/events.md, section 7."
  }
}
