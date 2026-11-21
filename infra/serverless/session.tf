# Signer of the web session JWTs (ADR-0012). It holds no role and runs no code: the
# auth-proxy calls IAM Credentials signJwt on it, Google keeps and rotates the private
# keys, and API Gateway validates the tokens against its public keys
# (https://www.googleapis.com/robot/v1/metadata/x509/<email>).
# The auth-proxy runtime identity is its only token creator (auth-proxy.tf).
resource "google_service_account" "session_signer" {
  project      = var.project_id
  account_id   = "session-signer"
  display_name = "Signer of the web session JWTs"
}

output "session_issuer" {
  description = "Issuer (iss) of the session JWTs, checked by API Gateway"
  value       = google_service_account.session_signer.email
}
