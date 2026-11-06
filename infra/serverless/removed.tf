# The application secrets moved to infra/iam (persistent, values survive a destroy).
# Forget them here instead of deleting them and their versions.
removed {
  from = google_secret_manager_secret.application

  lifecycle {
    destroy = false
  }
}
