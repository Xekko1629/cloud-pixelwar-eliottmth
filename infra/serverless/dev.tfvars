project_id           = "cloud-pixelwar-dev"
environment          = "dev"
enable_discord_hello = true
enable_auth_proxy    = true

# /draw path (SRV-05): workers, topics and push delivery, then Gateway routes
# /discord/interactions to the proxy instead of hello. Rollback: use_discord_proxy = false
# only; never disable the pipeline or delivery, which would delete queued messages.
enable_discord_pipeline = true
enable_discord_delivery = true
use_discord_proxy       = true
