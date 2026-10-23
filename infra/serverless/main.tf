locals {
  labels = {
    project     = "pixelwar"
    environment = var.environment
    managed_by  = "terraform"
  }
}

# Add one module "service" per proxy or worker here when its image is available.
# See modules/service/README.md for the module contract and an example.
