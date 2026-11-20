output "url" {
  description = "Public HTTPS URL of the gateway (default *.gateway.dev hostname)"
  value       = "https://${google_api_gateway_gateway.main.default_hostname}"
}

output "managed_service" {
  description = "Service Management name of the API (used by API keys and quotas)"
  value       = google_api_gateway_api.main.managed_service
}

output "service_account_email" {
  description = "Identity the gateway uses to call the proxies"
  value       = google_service_account.gateway.email
}

output "openapi" {
  description = "Rendered OpenAPI 2.0 specification (no secret inside)"
  value       = local.openapi
}

output "published_routes" {
  description = "METHOD /path of the routes currently served by the gateway, with their gateway auth"
  value       = [for operation in local.operations : "${upper(operation.method)} ${operation.path} (${operation.auth})"]
}
