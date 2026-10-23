output "application_secret_names" {
  description = "Secret resource names only, never secret values"
  value       = { for id, secret in google_secret_manager_secret.application : id => secret.name }
}
