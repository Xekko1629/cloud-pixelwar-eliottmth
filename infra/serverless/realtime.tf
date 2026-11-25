# Realtime of the browser (DRAW-03a, ADR-0015): the frontend opens Firestore listeners
# with the client library only (no Firebase Auth, Hosting nor web app). Two pieces:
#   - the Security Rules (firestore.rules): read-only deltas and config/global, no write;
#   - a browser API key, limited to the Firestore API and to the frontend pages.
# The key only identifies the project: what it can read is decided by the rules. It is
# public by design (served in /config.js) and passed to infra/frontend by remote state.
# APIs firebaserules and apikeys, and the deployer roles, come from infra/iam.
locals {
  realtime_enabled = var.enable_realtime

  # Pages allowed to use the key: the deployed frontend, plus local servers in dev only.
  realtime_referrers = concat(["${local.frontend_origin}/*"], var.realtime_extra_referrers)
}

resource "google_firebaserules_ruleset" "firestore" {
  count   = local.realtime_enabled ? 1 : 0
  project = var.project_id

  source {
    files {
      name    = "firestore.rules"
      content = file("${path.module}/firestore.rules")
    }
  }

  # A new ruleset is created before the release moves to it; the old one is deleted after.
  lifecycle {
    create_before_destroy = true
  }

  depends_on = [google_firestore_database.main]
}

# Binds the ruleset to the (default) database. Without a release, clients are refused.
resource "google_firebaserules_release" "firestore" {
  count   = local.realtime_enabled ? 1 : 0
  project = var.project_id

  name         = "cloud.firestore"
  ruleset_name = "projects/${var.project_id}/rulesets/${google_firebaserules_ruleset.firestore[0].name}"

  lifecycle {
    replace_triggered_by = [google_firebaserules_ruleset.firestore[0]]
  }
}

# A deleted API key stays reserved for 30 days: a fixed name would make destroy then
# apply fail. The suffix changes only when the key is recreated.
resource "random_id" "firestore_web_key" {
  count       = local.realtime_enabled ? 1 : 0
  byte_length = 4
}

resource "google_apikeys_key" "firestore_web" {
  count   = local.realtime_enabled ? 1 : 0
  project = var.project_id

  name         = "firestore-web-${random_id.firestore_web_key[0].hex}"
  display_name = "Frontend Firestore listeners (read-only by the Security Rules)"

  restrictions {
    api_targets {
      service = "firestore.googleapis.com"
    }

    browser_key_restrictions {
      allowed_referrers = local.realtime_referrers
    }
  }
}

output "firestore_web_api_key" {
  description = "Browser API key of the Firestore listeners (public, served in /config.js); null when realtime is disabled"
  value       = local.realtime_enabled ? google_apikeys_key.firestore_web[0].key_string : null
  sensitive   = true
}
