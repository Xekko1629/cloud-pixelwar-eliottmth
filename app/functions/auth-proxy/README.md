# auth-proxy

Connexion Discord OAuth2 et JWT de session du site web
([ADR-0012](../../../docs/adr/0012-identite-web-jwt-session.md)). Fonction proxy
derrière API Gateway, déclarée dans `infra/serverless/auth-proxy.tf` et activée par
`enable_auth_proxy`.

## Routes

| Route | Gateway | Rôle |
| --- | --- | --- |
| `GET /auth/login` | publique | URL d'autorisation Discord (scope `identify`) et `state` signé, valable 10 min |
| `POST /auth/exchange` `{ code, state }` | publique | Vérifie le `state`, échange le code, lit l'utilisateur, **jette le token Discord**, renvoie un JWT de session de 15 min |
| `POST /api/session/refresh` | JWT de session | Nouveau JWT avec la même identité, tant que la connexion Discord a moins de 12 h |

Réponses : `{ token, expires_at, user: { id, name } }` pour la session,
`{ authorize_url, state, expires_at }` pour la connexion, `{ error }` sinon. Codes
d'erreur : `invalid_request` (400), `invalid_state`, `code_refused`,
`invalid_session`, `session_expired` (401), `upstream_unavailable` (502),
`unavailable` (503, configuration incomplète). Toutes les réponses sont en
`Cache-Control: no-store`.

## Flux côté navigateur (WEB-02b)

1. `GET /auth/login`, garder `state` en `sessionStorage`, rediriger vers `authorize_url`.
2. Discord redirige vers `<frontend>/auth/callback?code=…&state=…`. Vérifier que `state`
   est celui gardé, puis `POST /auth/exchange`.
3. Envoyer `Authorization: Bearer <token>` à la gateway. Avant `expires_at`, appeler
   `POST /api/session/refresh` ; un 401 renvoie vers la connexion Discord.

## Signature et vérification

- Le JWT de session et le `state` sont signés par le compte `session-signer` via
  l'API IAM Credentials `signJwt` (`@pixelwar/shared/auth`). Google garde la clé
  privée : aucun secret de signature dans le dépôt, Secret Manager ou un state.
- Le `state` a une audience distincte (`<projet>/oauth-state`) : il ne peut pas servir
  de session, et une session ne peut pas servir de `state`.
- La fonction vérifie le `state` avec les clés publiques de `session-signer`, mises en
  cache une heure. La gateway vérifie les sessions avec les mêmes clés.
- Seule l'identité d'exécution de l'auth-proxy a `roles/iam.serviceAccountTokenCreator`,
  et seulement sur `session-signer`.

## Configuration

| Variable | Source |
| --- | --- |
| `FRONTEND_ORIGIN` | URL déterministe du frontend, `https://frontend-<numéro de projet>.<région>.run.app` |
| `SESSION_SIGNER`, `SESSION_AUDIENCE` | e-mail de `session-signer`, id du projet |
| `DISCORD_CLIENT_ID` | secret `discord-application-id` (version explicite) |
| `DISCORD_CLIENT_SECRET` | secret `discord-oauth-client-secret` (version explicite) |

`FRONTEND_ORIGIN` est la seule origine autorisée par CORS, et `<FRONTEND_ORIGIN>/auth/callback`
la redirect URI envoyée à Discord : elle doit être enregistrée **à l'identique** dans
l'application Discord de l'environnement (output `frontend_origin` du stack serverless,
ou `discord_redirect_uri` du stack frontend).

## Journalisation

Événements `auth.exchange.succeeded`, `auth.refresh.succeeded` (avec `user_id`),
`auth.exchange.invalid_state`, `auth.exchange.code_refused`, `auth.dependency_failed`.
Aucun code, `state`, token Discord, JWT ni message d'erreur amont n'est journalisé.
