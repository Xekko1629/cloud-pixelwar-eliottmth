# discord-proxy (Go)

Proxy des interactions Discord, en Go ([ADR-0016](../../../docs/adr/0016-proxy-discord-en-go.md)) :
vérifie la signature Ed25519, répond au PING, publie `/draw` et `/admin` sur
`discord-command` et diffère la réponse, dans les 3 secondes de Discord. Contrat
détaillé : [`docs/discord-proxy.md`](../../../docs/discord-proxy.md).

| Fichier | Rôle |
| --- | --- |
| `function.go` | Handler HTTP `handleDiscordProxy` (Functions Framework), routes, signature, réponses |
| `event.go` | Validation de l'interaction et enveloppe `discord-command` v1 |
| `publisher.go` | Publication REST Pub/Sub, jeton du serveur de métadonnées, préparation au démarrage |
| `telemetry.go` | Span `discord.interactions.draw`, métriques `pixelwar.function.*`, logs JSON corrélés |

## Même contrat que la version TypeScript

`app/functions/discord-proxy` reste l'implémentation de référence. Ses tests produisent
`app/testing/golden/discord-proxy.json` (26 cas : PING, `/draw`, `/admin`, signatures,
routes) ; `golden_test.go` rejoue ces cas et compare réponses et messages publiés. Après
un changement voulu du contrat, modifier les deux versions, puis régénérer depuis `app/` :

```sh
UPDATE_GOLDEN=1 npx vitest run functions/discord-proxy/src/golden.test.ts
```

## Tests et déploiement

```sh
cd app/go/discord-proxy
gofmt -l . && go vet ./... && go test -race -cover ./...
```

Le dossier est zippé tel quel par `infra/serverless` (module `function-source`) et compilé
par Cloud Build avec le runtime `go126` : aucune étape de build dans la CI.

| Variable | Usage |
| --- | --- |
| `DISCORD_PUBLIC_KEY`, `DISCORD_APPLICATION_ID` | Secrets, versions explicites |
| `GOOGLE_CLOUD_PROJECT`, `DISCORD_COMMAND_TOPIC` | Topic de publication |
| `APP_ENV` | `dev` ou `prd` : active l'export OTLP vers `telemetry.googleapis.com` |
| `K_SERVICE` | Posée par Cloud Run : déclenche la préparation du jeton et de la connexion |
