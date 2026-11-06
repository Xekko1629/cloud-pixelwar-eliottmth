locals {
  labels = {
    project     = "pixelwar"
    environment = var.environment
    managed_by  = "terraform"
  }
}

# Add one module "function" per HTTP function when its verified ZIP and build SA are available.
# See modules/function/README.md for the module contract and an example.
