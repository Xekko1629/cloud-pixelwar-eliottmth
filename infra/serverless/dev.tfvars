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

# Web path (DRAW-01, SRV-11): POST /api/pixels and the grid reads behind the gateway.
enable_web_api = true

# Firestore listeners of the frontend (DRAW-03a, ADR-0015). The local Vite server may use
# the browser key too: the Security Rules still only allow reading deltas and config/global.
enable_realtime          = true
realtime_extra_referrers = ["http://localhost:5173/*"]
