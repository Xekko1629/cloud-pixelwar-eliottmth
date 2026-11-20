# Resource-scoped IAM management for the CI deployer. Persistent resources live in
# this stack; the disposable stacks only add bindings on them (secretAccessor for a
# runtime, Workload Identity for External Secrets). These roles are bound on each
# resource, never at project level.
locals {
  deployer_iam_policy_roles = {
    secret = {
      role_id     = "deployerSecretIamPolicy"
      title       = "Deployer secret IAM policy"
      permissions = ["secretmanager.secrets.getIamPolicy", "secretmanager.secrets.setIamPolicy"]
    }
    serviceaccount = {
      role_id     = "deployerServiceAccountIamPolicy"
      title       = "Deployer service account IAM policy"
      permissions = ["iam.serviceAccounts.getIamPolicy", "iam.serviceAccounts.setIamPolicy"]
    }
  }
}

resource "google_project_iam_custom_role" "deployer_iam_policy" {
  for_each = local.deployer_iam_policy_roles

  role_id     = each.value.role_id
  title       = each.value.title
  description = "IAM policy of one resource only; bound per resource, never on the project."
  permissions = each.value.permissions

  depends_on = [google_project_service.apis]
}

# roles/editor carries no setIamPolicy permission and projectIamAdmin only covers the
# project policy. The bootstrap and serverless stacks add bindings on the resources they
# create (bucket and registry of the build identity, run.invoker of a worker, Pub/Sub
# topics and subscriptions), which can only be granted at project level before the
# resources exist. This gives the deployer nothing projectIamAdmin does not already
# allow; SEC-01 revisits both together.
resource "google_project_iam_custom_role" "deployer_resource_iam_policy" {
  role_id     = "deployerResourceIamPolicy"
  title       = "Deployer resource IAM policy"
  description = "IAM policies of the buckets, registries, functions, services and Pub/Sub resources the CI creates."
  permissions = flatten([
    for type in [
      "storage.buckets",
      "artifactregistry.repositories",
      "run.services",
      "cloudfunctions.functions",
      "pubsub.topics",
      "pubsub.subscriptions",
    ] : ["${type}.getIamPolicy", "${type}.setIamPolicy"]
  ])

  depends_on = [google_project_service.apis]
}

resource "google_project_iam_member" "deployer_resource_iam_policy" {
  project = var.project_id
  role    = google_project_iam_custom_role.deployer_resource_iam_policy.name
  member  = google_service_account.deployer.member
}

# roles/viewer cannot read these policies either, so PR plans of bootstrap and
# serverless would fail to refresh their bindings. Read only.
resource "google_project_iam_custom_role" "planner_resource_iam_read" {
  role_id     = "plannerResourceIamRead"
  title       = "Planner resource IAM read"
  description = "Read the IAM policies roles/viewer does not cover, for read-only PR plans."
  permissions = [
    "storage.buckets.getIamPolicy",
    "pubsub.topics.getIamPolicy",
    "pubsub.subscriptions.getIamPolicy",
  ]

  depends_on = [google_project_service.apis]
}

resource "google_project_iam_member" "planner_resource_iam_read" {
  project = var.project_id
  role    = google_project_iam_custom_role.planner_resource_iam_read.name
  member  = google_service_account.planner.member
}
