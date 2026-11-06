# Every API used by the project, in one place. This stack is applied by hand, so
# the CI deployer never needs to enable services. infra/bootstrap still enables
# a subset until it is removed; disable_on_destroy = false keeps both harmless.
locals {
  apis = toset([
    # CI identities (Workload Identity Federation)
    "cloudresourcemanager.googleapis.com",
    "iam.googleapis.com",
    "iamcredentials.googleapis.com",
    "sts.googleapis.com",
    # Budget, and billing account IAM of infra/access (this project is its quota project)
    "billingbudgets.googleapis.com",
    "cloudbilling.googleapis.com",
    # Secrets
    "secretmanager.googleapis.com",
    # Cluster of the self-hosted runners (infra/foundation)
    "container.googleapis.com",
    # Serverless application (infra/serverless)
    "artifactregistry.googleapis.com",
    "run.googleapis.com",
    "cloudfunctions.googleapis.com",
    "cloudbuild.googleapis.com",
    "eventarc.googleapis.com",
    "pubsub.googleapis.com",
    "firestore.googleapis.com",
    "apigateway.googleapis.com",
    "servicemanagement.googleapis.com",
    "servicecontrol.googleapis.com",
    "storage.googleapis.com",
    # Frontend: Firebase Hosting (ADR-0006) and Firebase Auth (ADR-0005)
    "firebase.googleapis.com",
    "firebasehosting.googleapis.com",
    "identitytoolkit.googleapis.com",
    # Observability
    "logging.googleapis.com",
    "monitoring.googleapis.com",
    "cloudtrace.googleapis.com",
    "telemetry.googleapis.com",
  ])
}

resource "google_project_service" "apis" {
  for_each = local.apis

  service            = each.value
  disable_on_destroy = false
}

moved {
  from = google_project_service.ci["cloudresourcemanager.googleapis.com"]
  to   = google_project_service.apis["cloudresourcemanager.googleapis.com"]
}

moved {
  from = google_project_service.ci["iam.googleapis.com"]
  to   = google_project_service.apis["iam.googleapis.com"]
}

moved {
  from = google_project_service.ci["iamcredentials.googleapis.com"]
  to   = google_project_service.apis["iamcredentials.googleapis.com"]
}

moved {
  from = google_project_service.ci["sts.googleapis.com"]
  to   = google_project_service.apis["sts.googleapis.com"]
}

moved {
  from = google_project_service.billingbudgets
  to   = google_project_service.apis["billingbudgets.googleapis.com"]
}

# prd only (former count = enable_runners)
moved {
  from = google_project_service.secretmanager[0]
  to   = google_project_service.apis["secretmanager.googleapis.com"]
}
