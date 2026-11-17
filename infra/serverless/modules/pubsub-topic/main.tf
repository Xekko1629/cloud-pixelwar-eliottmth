resource "google_pubsub_topic" "main" {
  project = var.project_id
  name    = var.name
  labels  = var.labels
}

# Additive, topic-scoped grants. The caller supplies the function module's runtime
# member; this module never creates a duplicate service account or an IAM policy.
resource "google_pubsub_topic_iam_member" "publisher" {
  for_each = var.publishers

  project = var.project_id
  topic   = google_pubsub_topic.main.name
  role    = "roles/pubsub.publisher"
  member  = each.value
}
