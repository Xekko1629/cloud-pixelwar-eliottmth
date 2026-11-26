# Warm-up of the functions (ADR-0017). Every minute, one Cloud Scheduler job per function
# calls GET /health on its default run.app URL: an instance that serves requests regularly
# is not stopped, so commands no longer pay the 2 to 3 s of a Node cold start. With
# request-based billing an idle instance costs nothing; only the few milliseconds of each
# call are billed (about 0.10 $ a month per job beyond the 3 free jobs of the account).
# Best effort only: the platform may still replace an instance.
#
# Workers have ingress "internal": Cloud Scheduler of the same project is an allowed source
# on the run.app URL (https://docs.cloud.google.com/run/docs/securing/ingress).
locals {
  # Only what the jobs need: the Cloud Run service name (IAM) and its run.app URL.
  warmup_targets = merge(
    local.discord_pipeline_enabled ? {
      for function in [module.command_worker[0], module.draw_worker[0], module.discord_notifier[0],
      module.admin_worker[0], module.render_worker[0]] : function.name => function.uri
    } : {},
    local.web_api_enabled ? { for function in [module.web_proxy[0], module.tile_reader[0]] : function.name => function.uri } : {},
    local.auth_proxy_enabled ? { (module.auth_proxy[0].name) = module.auth_proxy[0].uri } : {},
  )
  warmup = var.warmup_schedule == null ? {} : local.warmup_targets
}

# Its only right: invoke the warmed functions. It reads and writes nothing.
resource "google_service_account" "warmer" {
  count = length(local.warmup) > 0 ? 1 : 0

  project      = var.project_id
  account_id   = "function-warmer"
  display_name = "Function warm-up (Cloud Scheduler)"
  description  = "OIDC identity of the warm-up jobs; run.invoker on the warmed functions only (ADR-0017)"
}

# Gen2 HTTP invocation is authorized on the underlying Cloud Run service (same resource as
# the push invoker of module function and the gateway invoker).
resource "google_cloud_run_service_iam_member" "warmer_invoker" {
  for_each = local.warmup

  project  = var.project_id
  location = var.region
  service  = each.key
  role     = "roles/run.invoker"
  member   = google_service_account.warmer[0].member
}

resource "google_cloud_scheduler_job" "warmup" {
  for_each = local.warmup

  project          = var.project_id
  region           = var.region
  name             = "warmup-${each.key}"
  description      = "Keeps ${each.key} warm (ADR-0017)"
  schedule         = var.warmup_schedule
  time_zone        = "Etc/UTC"
  attempt_deadline = "15s"

  # A missed warm-up is not worth retrying: the next one comes a minute later.
  retry_config {
    retry_count = 0
  }

  http_target {
    http_method = "GET"
    uri         = "${each.value}/health"
    oidc_token {
      service_account_email = google_service_account.warmer[0].email
      audience              = each.value
    }
  }

  # The job must not call before it is allowed to: a refused call is a 403 in the logs.
  depends_on = [google_cloud_run_service_iam_member.warmer_invoker]
}

output "warmup_jobs" {
  description = "Warmed function -> Scheduler job name (ADR-0017)"
  value       = { for name, job in google_cloud_scheduler_job.warmup : name => job.name }
}
