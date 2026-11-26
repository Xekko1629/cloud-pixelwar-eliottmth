# API Gateway is cold after 15 to 20 minutes without traffic: the first requests then take
# 3 to 5 s more (API Gateway troubleshooting docs), measured at 3.75 s in dev on 21/11, beyond
# the 3 s Discord gives an interaction. A GET every minute on /discord/health (ADR-0017) keeps the
# gateway and the Discord proxy instance warm, for a few cents a month. Best effort only:
# the platform may still start a new instance.
resource "google_cloud_scheduler_job" "gateway_warmup" {
  count = var.warmup_schedule != null && contains(keys(local.gateway_backends), "discord") ? 1 : 0

  project          = var.project_id
  region           = var.region
  name             = "gateway-warmup"
  description      = "Keeps the API Gateway and the Discord proxy warm (Discord 3 s deadline)"
  schedule         = var.warmup_schedule
  time_zone        = "Etc/UTC"
  attempt_deadline = "30s"

  # A missed warm-up is not worth retrying: the next one comes a minute later.
  retry_config {
    retry_count = 0
  }

  # Public route answered by the proxy: no credentials are attached to the call.
  http_target {
    http_method = "GET"
    uri         = "${module.api_gateway[0].url}/discord/health"
  }
}
