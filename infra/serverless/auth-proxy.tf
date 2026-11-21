# auth-proxy (WEB-02a, ADR-0012): Discord OAuth2 login and web session JWTs, behind the gateway.
locals {
  auth_proxy_enabled = var.enable_auth_proxy

  # Deterministic Cloud Run URL of the frontend (infra/frontend): known before it is deployed,
  # so it is both the only CORS origin and the Discord redirect URI (<origin>/auth/callback).
  frontend_origin = "https://frontend-${data.google_project.current.number}.${var.region}.run.app"
}

data "google_project" "current" {
  project_id = var.project_id
}

module "auth_proxy_source" {
  source = "./modules/function-source"
  count  = local.auth_proxy_enabled ? 1 : 0

  name       = "auth-proxy"
  source_dir = "${path.root}/../../app/dist/functions/auth-proxy"
  bucket     = local.function_build.sources_bucket
}

module "auth_proxy" {
  source = "./modules/function"
  count  = local.auth_proxy_enabled ? 1 : 0

  project_id            = var.project_id
  region                = var.region
  name                  = "auth-proxy"
  service_type          = "proxy"
  source_archive        = module.auth_proxy_source[0].source_archive
  entry_point           = "handleAuthProxy"
  build_service_account = local.function_build.service_account
  build_repository      = local.function_build.repository
  labels                = local.labels
  min_instances         = 0
  max_instances         = 3
  timeout_seconds       = 15
  # Stateless and network-bound; a browser sends several requests at once.
  concurrency = 16
  environment_variables = {
    APP_ENV              = var.environment
    GOOGLE_CLOUD_PROJECT = var.project_id
    FRONTEND_ORIGIN      = local.frontend_origin
    SESSION_SIGNER       = google_service_account.session_signer.email
    SESSION_AUDIENCE     = var.project_id
  }
  secrets = {
    # The application id is the OAuth2 client id; only the client secret is sensitive.
    DISCORD_CLIENT_ID     = { secret = "discord-application-id", version = var.discord_application_id_version }
    DISCORD_CLIENT_SECRET = { secret = "discord-oauth-client-secret", version = var.discord_oauth_client_secret_version }
  }
}

# The auth-proxy signs with session-signer through IAM Credentials signJwt: token creator on
# that single account, never on the project nor on its own runtime identity.
resource "google_service_account_iam_member" "auth_proxy_signs_sessions" {
  count = local.auth_proxy_enabled ? 1 : 0

  service_account_id = google_service_account.session_signer.name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = module.auth_proxy[0].service_account_member
}

output "frontend_origin" {
  description = "Deterministic frontend URL: CORS origin of the auth-proxy; <origin>/auth/callback is the Discord redirect URI"
  value       = local.frontend_origin
}
