# Worker d'administration (BOT-08, DATA-04)

## Périmètre et état

`app/functions/admin-worker/` fournit le handler HTTP Functions Framework
`handleAdminWorker`. Il consomme `admin-requested` (push OIDC), publié par le
`command-worker` après autorisation, applique la commande dans Firestore, répond
à l'admin dans Discord, puis purge les anciennes tuiles après un `clear`.

Cette livraison est **locale, non déployée** : ni la fonction, ni le topic
`admin-requested`, ni son abonnement ne sont déclarés en Terraform. Seule la
politique TTL de `admin_events` l'est (`infra/serverless/firestore.tf`).

## Sous-commandes

| Commande | Effet dans Firestore | Réponse Discord |
| --- | --- | --- |
| `/admin pause` | `config/global.paused = true` | « Dessins suspendus… » |
| `/admin resume` | `config/global.paused = false` | « Dessins réactivés. » |
| `/admin clear` | `canvas_version + 1`, `bounds = null`, puis purge | « Grille effacée : version N… » |
| `/admin ratelimit user limit` | `ratelimit_overrides/{user} = { limit_per_minute, updated_at }` | « Quota de cet utilisateur : … » |
| `/admin size` | `config/global.size = null` (grille infinie) | « La grille est désormais infinie. » |
| `/admin size width height` | `config/global.size = { width, height }` (10 000 à 10⁹) | « Grille bornée à … » |

Les autres champs de `config/global` sont préservés (mise à jour ciblée). Le
`draw-worker` lit ces valeurs dans sa transaction DATA-02 : la pause, la taille
et la version s'appliquent au dessin suivant, sur Discord comme sur le web.

- **`ratelimit`** n'écrit que la limite personnelle : le compteur `users/{uid}` et
  sa fenêtre ne sont jamais modifiés (`docs/rate-limits.md`). `limit = 0` interdit
  de dessiner à cet utilisateur.
- **`size`** ne supprime rien : les pixels hors du rectangle restent stockés et
  réapparaissent si la grille est agrandie (ADR-0007).
- **`clear`** a un coût constant : seule la version change. Les tuiles de
  l'ancienne version ne sont plus lues par DATA-02 ni par le `tile-reader`.

## Configuration globale absente

Si `config/global` n'existe pas ou n'a pas de `canvas_version` valide, rien n'est
écrit et l'admin reçoit « Configuration globale absente ». Le worker ne crée
jamais un document partiel, que DATA-02 refuserait. L'initialisation de
`config/global` (dont `default_limit_per_minute = 20`) reste une opération
séparée, sans commande `/admin` à ce jour.

## Autorisation : deux barrières

1. Le `command-worker` (BOT-04) ne publie `admin-requested` que pour un utilisateur
   ou un rôle de l'allow-list ; sinon il publie `command-rejected`, auquel le
   `discord-notifier` répond.
2. L'`admin-worker` revérifie la même allow-list avec `actor.uid` et `actor.roles`,
   présents dans `admin-requested` uniquement. Un auteur absent reçoit le message
   de refus, et **aucun effet n'est appliqué**.

Les visibilités et permissions de l'interface Discord ne remplacent jamais ce
contrôle.

## Relivraisons et ordre des étapes

Chaque commande est enregistrée dans `admin_events/<event_id>`, **dans la même
transaction** que son effet. L'`event_id` est celui du `discord-command`, identique
d'une livraison à l'autre.

1. Transaction : si `admin_events/<event_id>` existe, le résultat enregistré est
   repris sans rien réappliquer. Un même `event_id` avec une autre sous-commande
   est un message invalide (`400`).
2. Réponse Discord (`PATCH @original`) après le commit.
3. Pour un `clear` : purge des anciennes versions.
4. `204`.

Exemple : un `clear` relivré deux fois incrémente `canvas_version` **une seule
fois** ; la seconde livraison renvoie le même message Discord et reprend la purge.

| Situation | Réponse |
| --- | --- |
| Commande appliquée, refusée ou déjà traitée, réponse affichée | `204` |
| Token d'interaction expiré (15 min) | Log `admin.notification_expired`, `204` : l'effet reste appliqué |
| Interaction inconnue de Discord (`404` après 10 s) | Log `admin.notification_unknown_interaction`, `204` : l'effet reste appliqué |
| Discord indisponible avant expiration | `503` (avec `Retry-After` si Discord en donne un) : la relivraison renvoie le même message |
| Purge interrompue par son budget de temps | `503` : la relivraison reprend la purge, sans effacer à nouveau |
| Message invalide, `event_id` réutilisé pour une autre sous-commande | `400`, puis DLQ |
| Erreur Firestore | `503` |

`admin_events` expire après 15 jours (`expire_at`, TTL Firestore), comme les
résultats de dessin.

## Purge après `clear`

`purgeOldVersions` supprime les documents `tile_colors` et `tile_metadata` dont
`canvas_version` est inférieure à la version courante, par lots de 400, dans un
budget de 120 s. Elle ne lit que les noms des documents. Elle est idempotente :
une nouvelle exécution ne trouve que ce qui reste, et un `clear` suivant purge
aussi les versions encore plus anciennes.

Les deltas des anciennes versions expirent par leur TTL d'une heure. Les
résultats de déduplication sont conservés volontairement. Le délai
d'acquittement de l'abonnement devra dépasser ce budget de purge.

## Configuration du runtime

| Variable | Usage |
| --- | --- |
| `GOOGLE_CLOUD_PROJECT` | Projet de la base Firestore `(default)` |
| `APP_ENV` | `dev` ou `prd`, pour l'export de télémétrie |
| `DISCORD_APPLICATION_ID` | Application attendue dans le contexte Discord |
| `ADMIN_REQUESTED_SUBSCRIPTION` | Nom complet de l'abonnement source |
| `DISCORD_ADMIN_ALLOWLIST` | JSON secret `{ "user_ids": [], "role_ids": [] }`, le même que le `command-worker` |

Une configuration absente ou invalide produit un `503`. Le compte d'exécution
aura besoin de `roles/datastore.user`.

## Réponse Discord

Le `PATCH` passe par le client partagé `@pixelwar/shared/discord`, extrait du
`discord-notifier` : hôte fixe, token encodé dans l'URL, redirections interdites,
corps de réponse jamais lu, aucun token dans les logs ou les erreurs. Les
messages sont des phrases fixes, sans texte fourni par l'utilisateur et sans
mention.

## Observabilité

Un span consommateur `admin-requested` par message (SRV-08), avec l'âge de
l'interaction.

| `event_type` | Quand |
| --- | --- |
| `admin.<sous-commande>.applied` / `.replayed` / `.rejected` | Résultat de la transaction |
| `admin.unauthorized` | Auteur hors allow-list à la revérification |
| `admin.notification_expired` | Réponse non affichée, token expiré |
| `admin.notification_unknown_interaction` | Réponse non affichée, interaction jamais acquittée par Discord |
| `admin.purge.complete` / `admin.purge.incomplete` / `admin.purge.retry` | Purge après `clear` |
| `admin.message.invalid` / `admin.failed` | `400` / `503` |

## Tests locaux

Depuis `app/` :

```sh
npx vitest run functions/admin-worker functions/discord-notifier
npm run test:integration   # dont admin.integration.test.ts
```

Les messages de test sont produits par le vrai `routeCommand` du
`command-worker`. Le test d'intégration observe les effets à travers la vraie
transaction DATA-02 sur l'émulateur : dessin refusé pendant la pause puis
accepté après `resume`, `clear` relivré en parallèle appliqué une seule fois,
anciennes tuiles purgées, `size` qui rejette `out_of_bounds`, limite personnelle
sans remise à zéro du compteur.

## Reste à faire avant la validation dev

- Terraform : fonction, compte `datastore.user`, accès au secret de l'allow-list,
  topics `admin-requested` et `command-rejected`, abonnements push OIDC (dont le
  troisième abonnement du notifier) et délai d'acquittement supérieur au budget de
  purge.
- Initialisation de `config/global` dans chaque environnement.
