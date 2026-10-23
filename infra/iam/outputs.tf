output "wif_provider" {
  description = "WIF_PROVIDER for the <env> and <env>-plan GitHub environments"
  value       = google_iam_workload_identity_pool_provider.github.name
}

output "deployer_sa" {
  description = "DEPLOYER_SA for the <env> GitHub environment"
  value       = google_service_account.deployer.email
}

output "planner_sa" {
  description = "DEPLOYER_SA for the <env>-plan GitHub environment"
  value       = google_service_account.planner.email
}
