# Shared inputs of every function (ADR-0008, ADR-0009). The CI runs npm run build:functions
# before plan and apply; each function is then two module calls, for example (hello, #39):
#
#   module "hello_source" {
#     source     = "./modules/function-source"
#     name       = "hello-proxy"
#     source_dir = "${path.root}/../../app/dist/functions/hello-proxy"
#     bucket     = local.function_build.sources_bucket
#   }
#
#   module "hello" {
#     source                = "./modules/function"
#     project_id            = var.project_id
#     region                = var.region
#     name                  = "hello-proxy"
#     service_type          = "proxy"
#     source_archive        = module.hello_source.source_archive
#     entry_point           = "handleHello"
#     build_service_account = local.function_build.service_account
#     build_repository      = local.function_build.repository
#   }
locals {
  # Persistent resources of infra/bootstrap: they survive a destroy of this stack.
  function_build = {
    sources_bucket  = "${var.project_id}-function-sources"
    service_account = "projects/${var.project_id}/serviceAccounts/function-builder@${var.project_id}.iam.gserviceaccount.com"
    repository      = "projects/${var.project_id}/locations/${var.region}/repositories/pixelwar"
  }
}

output "function_build" {
  description = "Sources bucket, build identity and image repository shared by every function"
  value       = local.function_build
}
