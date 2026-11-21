locals {
  # Route catalogue of the single public entry point (subject §3.1, ADR-0012).
  # A route is published once its backend is listed in local.gateway_backends.
  # auth defaults to "session" (session JWT validated by the gateway, ADR-0012): a public
  # route must say auth = "none". cors = true adds the OPTIONS preflight route.
  gateway_routes = [
    {
      # Discord interactions: public at the gateway, the proxy verifies the Ed25519 signature.
      path         = "/discord/interactions"
      method       = "post"
      backend      = "discord"
      operation_id = "discordInteraction"
      summary      = "Discord slash command or PING (signature verified by discord-proxy)"
      # Discord expects an answer within 3 s; never wait longer for the proxy.
      deadline_seconds = 3
      auth             = "none"
    },
    {
      path         = "/auth/login"
      method       = "get"
      backend      = "auth"
      operation_id = "authLogin"
      summary      = "Discord authorization URL and signed state"
      # No token yet: the user is logging in.
      auth = "none"
      cors = true
    },
    {
      path         = "/auth/exchange"
      method       = "post"
      backend      = "auth"
      operation_id = "authExchange"
      summary      = "Exchange the Discord code for a session JWT (Discord token dropped)"
      auth         = "none"
      cors         = true
    },
    {
      path         = "/api/session/refresh"
      method       = "post"
      backend      = "auth"
      operation_id = "refreshSession"
      summary      = "New session JWT while the Discord login is less than 12 h old"
      cors         = true
    },
    {
      path         = "/api/pixels"
      method       = "post"
      backend      = "api"
      operation_id = "drawPixels"
      summary      = "Draw 1 to 500 pixels, published as one Pub/Sub event per pixel"
      cors         = true
    },
    # Grid reads (SRV-11, ADR-0013), served by the tile-reader with ETag and gzip.
    {
      path         = "/api/regions/{rx}/{ry}/tiles"
      method       = "get"
      backend      = "tiles"
      operation_id = "regionTiles"
      summary      = "Painted tiles of a 1024x1024 region, binary and gzip"
      cors         = true
    },
    {
      path         = "/api/tiles/{tx}/{ty}/meta"
      method       = "get"
      backend      = "tiles"
      operation_id = "tileMetadata"
      summary      = "Pseudonym and date of the last pixels of a tile"
      cors         = true
    },
    {
      path         = "/api/state"
      method       = "get"
      backend      = "tiles"
      operation_id = "userState"
      summary      = "Global state and remaining quota of the caller"
      cors         = true
    },
    {
      # Temporary end-to-end check of the C05 checklist (SRV-09, #39): called through
      # the gateway with authentication, hence the default session auth.
      path         = "/hello"
      method       = "get"
      backend      = "hello"
      operation_id = "hello"
      summary      = "C05 checklist service, removed once the real proxies are live"
    },
  ]

}
