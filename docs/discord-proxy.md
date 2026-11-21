# Proxy Discord Q2 (BOT-03)

## Périmètre et état

Depuis l'[ADR-0016](adr/0016-proxy-discord-en-go.md), le proxy déployé est écrit en
**Go** ([`app/go/discord-proxy`](../app/go/discord-proxy/README.md), runtime `go126`).
`app/functions/discord-proxy` (TypeScript) reste l'implémentation de référence du
contrat : ses tests produisent `app/testing/golden/discord-proxy.json`, que les tests
Go rejouent. Le `command-worker` valide ses messages contre cette référence.

Le proxy vérifie la signature Ed25519 du corps brut (fenêtre de timestamp
±5 minutes), répond au PING et publie `/draw` dans `discord-command`. Il attend
la confirmation Pub/Sub avant de répondre `200 { "type": 5 }`. Aucun traitement
n'est lancé après la réponse. Les autres commandes reçoivent une réponse
immédiate éphémère « pas encore disponible » sans publication.

`/admin` est aussi publié. Discord envoie la sous-commande comme une option de
type 1 qui contient ses propres options ; le proxy l'aplatit en
`{ "subcommand": "pause" }` ou `{ "subcommand": "ratelimit", "user": "…", "limit": 5 }`,
le format du `command-worker`. Sa réponse différée porte `flags: 64` : la
confirmation ou le refus n'est visible que par son auteur. `/admin size` avec une
seule des deux dimensions reçoit une réponse immédiate, sans publication, car
Discord ne sait pas exiger « les deux ou aucune ».

`GET /discord/health` répond `204` sans signature, sans publication et sans log :
c'est la cible du job Scheduler qui garde la gateway et le proxy chauds
([détails](deploy-draw-path.md#démarrage-à-froid-de-la-gateway-2111-1600)).

Le pseudo est coupé à 32 caractères (points de code), la limite du
`command-worker` : un pseudo Discord plus long envoyait sinon `/draw` en DLQ.

Il ne dessine pas, ne consulte pas Firestore et n'applique ni quota, ni pause,
ni autorisation admin. La validation des options vérifie uniquement la forme,
les bornes techniques des coordonnées et les 16 couleurs, pas la taille de la
toile. Les interactions hors guilde ne sont pas prises en charge.

## Configuration du runtime futur

| Variable | Usage |
| --- | --- |
| `DISCORD_PUBLIC_KEY` | Clé publique Ed25519, 64 caractères hexadécimaux |
| `DISCORD_APPLICATION_ID` | Application attendue, contrôlée même au PING |
| `GOOGLE_CLOUD_PROJECT` | Projet qui porte le topic |
| `DISCORD_COMMAND_TOPIC` | Topic à publier, à provisionner séparément |

Une configuration incomplète produit un 503, y compris au PING. Aucun appel
réseau n'est effectué à l'import du handler. Le client Pub/Sub est initialisé
à la première commande, pas au PING.

## Contrat provisoire `discord-command`, version 1

Ce contrat est **à relire avec le propriétaire d'ARCH-03** avant le branchement
du consommateur. Ce document ne remplace pas le catalogue complet des événements.

| Champ | Contrat |
| --- | --- |
| `schema_version` | `1` |
| `event_id` | UUIDv8 dérivé de SHA-256 de `pixelwar:discord-command:v1:<application_id>:<interaction_id>` ; 128 bits, version et variante UUID fixées |
| `correlation_id` | Identique à `event_id` pour cette entrée |
| `occurred_at` | Date UTC millisecondes extraite du snowflake Discord, jamais de l'horloge au rejeu |
| `source` | `discord` |
| `actor` | `uid` Discord, `name` username, `roles` triés et dédupliqués |
| `payload.command` | `draw` |
| `payload.options` | `x`, `y`, `color`, entiers validés |
| `payload` (contexte) | `interaction_id`, `application_id`, `guild_id`, `channel_id`, `interaction_token` |

Les attributs Pub/Sub contiennent `correlation_id` et un `traceparent` W3C.
Le proxy démarre un span racine neuf après validation de la signature et de la
commande, sans reprendre le contexte de trace HTTP public. Le `correlation_id`
reste l'ID métier stable ; les traces peuvent être échantillonnées (`01`).
Le socle SRV-08 est branché, avec export avant réponse lorsqu'il est configuré ;
les tests locaux ne prouvent pas la réception par Cloud Trace. Voir
[le contrat d'observabilité](observability.md#instrumentation-des-fonctions-du-parcours-draw).

Le proxy ne déduplique pas : deux livraisons peuvent produire deux messages
avec la même identité métier. Le consommateur doit être idempotent. En cas de
timeout de publication, le message peut déjà avoir été accepté : un 503
n'implique pas l'absence de publication et ne garantit pas un retry Discord.

### Données sensibles

Le token d'interaction est nécessaire au futur notifier, mais expire après
15 minutes. Il figure uniquement dans le corps du message, jamais dans les
logs, attributs de trace, réponses d'erreur ou captures. Ne jamais journaliser
l'événement ou l'erreur brute du SDK. Les rôles sont des données de contexte,
pas une décision d'autorisation prise par le proxy.

SRV-05 devra restreindre l'accès au topic, aux abonnements et aux DLQ. Une
rétention longue ne prolonge pas la validité du token : les rejeux tardifs
devront séparer traitement métier et notification expirée.

## Tests locaux

Depuis `app/` :

```bash
npm ci
npm run typecheck
npm test -- functions/discord-proxy
npm run test:integration
npm run build:functions -- discord-proxy
```

Le test `app/testing/discord-proxy.integration.test.ts` utilise le projet factice
`demo-pixelwar-test`, un topic et un abonnement éphémères, ainsi qu'une requête
signée avec une clé générée en mémoire. Aucun secret Discord réel n'est requis.
Le garde-fou d'intégration refuse les endpoints d'émulateur distants et les
projets non factices. Voir [les tests](testing.md) pour Java et les émulateurs.

L'intégration appelle le handler et le vrai adaptateur Pub/Sub, puis lit le
message. Elle ne passe pas par un serveur HTTP réel, ni API Gateway, et ne
valide pas IAM/OIDC.

## Délai de réponse

L'adaptateur désactive les retries SDK, limite le RPC de publication à 1 seconde
et publie sans attendre un batch de plusieurs messages. Il attend réellement
la promesse du SDK : pas de `Promise.race` qui laisserait une publication en
arrière-plan après la réponse.

Ce délai RPC **ne borne pas toute l'initialisation** (credentials, connexion,
cold start). Le seuil Discord de 3 secondes doit être mesuré en dev, à froid et
à chaud. Ne pas déduire les performances du proxy des mesures de la sonde.

## Infrastructure dev

Le proxy est déclaré dans `infra/serverless/discord-proxy.tf`, le topic
`discord-command` et son consommateur `command-worker` dans
`infra/serverless/discord-command.tf`. Le worker de diagnostic
`discord-command-verify` a été retiré quand le `command-worker` l'a remplacé, avec
sa phase IAM dédiée (`infra/iam/discord-verify.tf`) : le deployer gère désormais
les politiques des comptes de service par `roles/iam.serviceAccountAdmin`.

- `enable_discord_pipeline` crée les fonctions, identités et topics, **en dev seulement**.
- `enable_discord_delivery` crée les abonnements push, leurs DLQ et les droits de
  l'agent Pub/Sub.
- `use_discord_proxy` choisit le proxy comme backend Gateway de
  `/discord/interactions`, à la place de la sonde hello. Il est refusé sans livraison.

Le déploiement, le retour en arrière et la checklist de test manuel du parcours
complet sont décrits dans [Déploiement dev du parcours `/draw`](deploy-draw-path.md).

Le message `discord-command` conserve le token d'interaction 7 jours dans
l'abonnement et sa DLQ : restreindre les lecteurs, ne jamais afficher de corps brut.

### Tests locaux

Après build des fonctions, dans `infra/serverless` :

```bash
terraform init -backend=false -input=false
terraform validate
terraform test
```

`tests/discord-pipeline.tftest.hcl` simule tous les providers, même pour ses runs
`command = apply` : aucun apply GCP, state distant ou lecture de secret. Il vérifie
la séparation dev/prd, les phases création, livraison et bascule, l'invoker
dédié de chaque worker et les noms d'abonnements attendus par les workers. Ces
tests ne prouvent pas l'accès effectif dans GCP.
