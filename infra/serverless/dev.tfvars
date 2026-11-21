project_id           = "cloud-pixelwar-dev"
environment          = "dev"
enable_discord_hello = true
enable_auth_proxy    = true

# Prepare resources only. Switching Discord traffic requires a separate review.
enable_discord_pipeline = true
enable_discord_delivery = false
use_discord_proxy       = false
