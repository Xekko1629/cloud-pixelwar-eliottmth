# Catalogue des événements — ARCH-03

Ce catalogue décrit les messages échangés sur Pub/Sub entre les proxies, les workers et les sources externes (Cloud Storage, Cloud Scheduler). Le choix du broker Pub/Sub en push authentifié par OIDC est décrit dans [ADR-0002](adr/0002-broker-pubsub-push.md). Les workers sont des Cloud Run functions à ingress interne ([ADR-0008](adr/0008-compute-cloud-run-functions.md)).

Le topic `discord-command` (v1) est le premier contrat implémenté : `discord-proxy` le produit, `command-worker` le consomme et le worker de diagnostic `discord-command-verify` le valide (`app/functions/`). Les topics du parcours `/draw` sont ensuite implémentés par `command-worker` (BOT-04), `draw-worker` (DRAW-02) et `discord-notifier` (BOT-05) : `pixel-draw`, `pixel-processed`, `pixel-rejected`, ainsi que `render-requested`, `snapshot-requested`, `admin-requested` et `command-rejected` côté producteur. Les types partagés sont dans `app/shared/src/events/`. Les autres topics sont fixés ici avant leur implémentation. Les points que les sources ne tranchent pas sont marqués **À valider** et repris dans la section 9.

Dans les tableaux, la colonne « Origine » indique la source du point : un ADR, un ticket (`#n`), un fichier du dépôt, ou « Proposition » (à valider).

## 1. Enveloppe métier

Chaque message métier porte l'enveloppe suivante, sérialisée en JSON UTF-8. En push, elle arrive encodée en base64 dans `message.data` (section 4).

| Champ | Type | Obligatoire | Format | Origine | Rôle |
|---|---|---|---|---|---|
| `schema_version` | entier | oui | `1` | `app/functions/discord-proxy/src/event.ts` | Version de l'enveloppe et du `payload`. Un consommateur refuse une version qu'il ne connaît pas. |
| `type` | string | oui, sauf `discord-command` | Nom du topic de publication (`pixel-draw`, `pixel-processed`, etc.) | `app/shared/src/events/` | Permet au consommateur de refuser un message publié sur le mauvais topic, et au `discord-notifier` de vérifier que l'abonnement reçu correspond au type. Absent de `discord-command` v1, dont le contrat est figé par le proxy. |
| `event_id` | string | oui | UUID canonique en minuscules, non nul | `app/shared/src/grid/event-order.ts` ; `event.ts` | Identifiant unique de l'événement, clé de déduplication (DATA-02). Pour `discord-command`, il est dérivé de l'interaction : UUID de forme v8 tiré du SHA-256 de `pixelwar:discord-command:v1:<application_id>:<interaction_id>`. Il est donc identique d'une livraison à l'autre. |
| `correlation_id` | string | oui | `^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$` ; UUID canonique en minuscules pour `pixel-draw`, `pixel-processed` et `pixel-rejected` | `app/shared/src/observability/context.ts` ; `draw-worker` et `discord-notifier` (`message.ts`) | Relie logs, spans et messages d'une même action (BOT-09, OBS-03). Généré par le proxy, jamais repris d'un client (`docs/observability.md`), puis recopié tel quel par chaque worker. Pour `discord-command`, égal à `event_id`. |
| `occurred_at` | string | oui | ISO 8601 UTC avec millisecondes : `AAAA-MM-JJTHH:MM:SS.mmmZ` | `event-order.ts` ; `event.ts` | Date de création de l'événement. Sert à la latence de bout en bout et à la règle last-write-wins (ADR-0002). Pour `discord-command`, c'est la date encodée dans l'id d'interaction Discord (snowflake). Voir la section 9 pour les événements système. |
| `source` | string | oui | `discord` ou `web` | ticket #28 | Origine de l'action. Les événements système (Cloud Scheduler, Cloud Storage) n'ont pas de valeur ici : **À valider**. |
| `actor` | object | oui | `discord-command` et `admin-requested` : `{ "uid": string, "name": string, "roles": string[] }` ; autres topics : `{ "uid": string, "name": string }` | `event.ts` ; `app/shared/src/events/` ; `uid` = id Discord (ADR-0012) | Auteur de l'action. `uid` est l'id Discord, `name` le pseudo au moment de l'action (repris dans les métadonnées de pixel, ADR-0007). `roles` (ids des rôles Discord, triés et sans doublon) ne sert qu'à l'autorisation faite par le `command-worker` : il n'est pas propagé en aval. Le `web-proxy` (DRAW-01) publie donc un `actor` sans `roles`. |
| `payload` | object | oui | Schéma propre à chaque topic (section 3) | ticket #28 | Données métier. |

Le contexte de trace (`traceparent`) n'est **pas** dans le corps : il ne circule que dans les attributs Pub/Sub (section 1.1). Il n'existe donc qu'une source de vérité.

Exemple d'enveloppe (valeurs fictives, `payload` d'un `pixel-draw`) :

```json
{
  "schema_version": 1,
  "type": "pixel-draw",
  "event_id": "3f6c2a9e-1b7d-8e8f-9a52-6c0d4b7e1f20",
  "correlation_id": "3f6c2a9e-1b7d-8e8f-9a52-6c0d4b7e1f20",
  "occurred_at": "2026-11-13T10:15:30.123Z",
  "source": "web",
  "actor": { "uid": "123456789012345678", "name": "exemple", "roles": [] },
  "payload": {
    "pixels": [{ "x": 12, "y": -40, "color": 5 }]
  }
}
```

### 1.1 Attributs Pub/Sub de propagation

Le producteur place exactement deux attributs sur le message. Le consommateur de `discord-command` refuse un message qui en porte d'autres (`app/functions/discord-command-verify/src/message.ts`).

| Attribut | Format | Pourquoi |
|---|---|---|
| `traceparent` | W3C Trace Context : `00-<trace-id sur 32 hex>-<span-id sur 16 hex>-<flags sur 2 hex>`, identifiants non nuls | Restaurer le parent du span du worker avant de lire le corps (`docs/observability.md`). Le proxy crée un contexte neuf : il ne reprend jamais un en-tête de trace venu d'Internet. |
| `correlation_id` | Égal au `correlation_id` du corps | `extractMessageContext` lit `carrier.correlation_id` (`context.ts`). |

Le worker ouvre son span et fixe le `correlation_id` à partir des attributs **avant** de décoder et valider le corps. Ainsi, un message au corps invalide reste corrélé dans les logs et dans la trace (section 8). Les attributs permettent aussi de suivre un message dans la console Pub/Sub sans le décoder.

Les autres champs (`event_id`, `occurred_at`, `source`, `actor`, `payload`) ne vivent que dans le corps.

## 2. Topics

| Topic | Producteur(s) | Consommateur(s) (abonnement) | Ticket(s) |
|---|---|---|---|
| `discord-command` | `discord-proxy` (après réponse différée `type: 5`) | `command-worker` | BOT-03, BOT-04 |
| `pixel-draw` | `web-proxy` (`POST /api/pixels`) ; `command-worker` pour `/draw` (`source = discord`) | `draw-worker` | DRAW-01, DRAW-02, BOT-04 |
| `pixel-processed` | `draw-worker` | `discord-notifier` (acquitte sans action les résultats `source = web`) ; consommateur de marquage de la vue éloignée | DRAW-02, BOT-05, DATA-05c |
| `pixel-rejected` | `draw-worker` | `discord-notifier` | DRAW-02, BOT-05 |
| `command-rejected` | `command-worker` (`/admin` ou `/snapshot` non autorisé) | `discord-notifier` (réponse du refus) | BOT-04, BOT-08 |
| `admin-requested` | `command-worker` (`/admin`, après autorisation) | `admin-worker` | BOT-04, BOT-08, DATA-04 |
| `render-requested` | `command-worker` (`/get`) | `render-worker` | BOT-04, BOT-06 |
| `snapshot-requested` | `command-worker` (`/snapshot`) | `snapshot-worker` | BOT-04, BOT-07a |
| `snapshot-ready` | Cloud Storage : notification `OBJECT_FINALIZE` du bucket `snapshots` (message natif, sans enveloppe, section 5) | `snapshot-notifier` | SRV-07, BOT-07b |
| `overview-tick` (nom **à valider**) | Cloud Scheduler (message natif, section 6) | `overview-worker` | SRV-05, DATA-05c |

Un pixel posé sur le web n'est pas notifié par `pixel-rejected` : le dernier rejet et sa raison sont reportés dans `users/{uid}`, que le navigateur lit par `GET /api/state` au chargement et après chaque trait (DRAW-04 ; ADR-0015). Le nom du champ (par exemple `last_rejection`) est une proposition. Le topic `pixel-rejected` ne sert donc qu'au `discord-notifier`.

Les DLQ sont décrites en section 7.

## 3. Schémas des `payload`

Les exemples ci-dessous donnent le `payload` seul ; l'enveloppe de la section 1 s'applique.

### 3.1 `discord-command`

Contrat v1 implémenté (`app/functions/discord-proxy/src/event.ts`). Le proxy ne publie que `/draw` ; les autres commandes suivront le même schéma, avec leurs propres `options`.

| Champ | Type | Obligatoire | Contrainte | Origine |
|---|---|---|---|---|
| `command` | string | oui | `draw` (puis `get`, `snapshot`, `admin`) | BOT-02 ; BOT-04 (routage) |
| `options` | object | oui | Objet aplati. Pour `draw` : exactement `x`, `y`, `color`, entiers, avec les bornes de `pixel-draw` (section 3.2). | `event.ts` ; le `command-worker` revalide (`docs/discord-commands.md`) |
| `interaction_id` | string | oui | Snowflake Discord | BOT-04 (idempotence par id d'interaction) |
| `application_id` | string | oui | Snowflake, égal à l'application de l'environnement | `event.ts` : un callback d'une autre application est refusé |
| `guild_id` | string | oui | Snowflake | `event.ts` |
| `channel_id` | string | oui | Snowflake | BOT-03 |
| `interaction_token` | string | oui | **Secret.** 1 à 4096 caractères, valide 15 min. Jamais journalisé. | BOT-03 ; BOT-05 |

Les rôles Discord de l'auteur sont dans `actor.roles` (section 1), pas dans le `payload`.

Le `command-worker` revalide le message de bout en bout : `event_id`, `correlation_id` et `occurred_at` doivent être ceux que le proxy dérive de l'interaction, sinon le message est invalide (`400`). Les champs `application_id`, `interaction_id`, `guild_id`, `channel_id` et `interaction_token` forment ensuite le **contexte Discord** (`DiscordContext`, `app/shared/src/events/discord.ts`), recopié dans les messages en aval pour que le `discord-notifier` puisse modifier la réponse d'origine.

```json
{
  "command": "draw",
  "options": { "x": 12, "y": -40, "color": 5 },
  "interaction_id": "1100000000000000001",
  "application_id": "1000000000000000000",
  "guild_id": "1200000000000000000",
  "channel_id": "223344556677889900",
  "interaction_token": "<jeton d'interaction, secret>"
}
```

### 3.2 `pixel-draw`

| Champ | Type | Obligatoire | Contrainte | Origine |
|---|---|---|---|---|
| `pixels` | array | oui | De 1 à 500 éléments | `DEFAULT_MAX_BATCH_PIXELS = 500` (`app/shared/src/grid/constants.ts`) ; ADR-0007 (« 500 par défaut, configurable ») |
| `pixels[].x` | entier | oui | De -1 000 000 000 à 1 000 000 000 | ADR-0007 ; `COORDINATE_LIMIT` (`constants.ts`) |
| `pixels[].y` | entier | oui | Idem `x` | Idem |
| `pixels[].color` | entier | oui | De 1 à 16 : index dans la palette. `0` (non peint) est interdit. | ADR-0007 ; `assertColor` (`constants.ts`) |
| `discord` | object | si `source = discord`, interdit sinon | `DiscordContext` de la section 3.1. **Contient le token d'interaction, secret.** | BOT-04 ; `draw-worker` (`message.ts`) |

Identifiants :

- Pour `source = discord`, le `command-worker` reprend l'`event_id`, le `correlation_id` et l'`occurred_at` du `discord-command`. Un `discord-command` relivré produit donc le même `pixel-draw`, que DATA-02 déduplique par `event_id`. Le `draw-worker` vérifie que l'`event_id` correspond bien à `discord.interaction_id`, et que `occurred_at` est la date du snowflake.
- Pour `source = web`, le `web-proxy` (DRAW-01) génère l'`event_id` (UUID) et le `correlation_id`. Une requête rejouée par le navigateur doit porter le même `event_id` pour être dédupliquée : le mécanisme est à définir dans DRAW-01.
- Le `pixel-draw` issu de `/draw` contient exactement un pixel.

Contraintes complémentaires :

- Pas deux fois la même coordonnée dans un lot. Le code partagé la refuse (`app/shared/src/grid/batch.ts`, « Duplicate coordinate in draw batch »). Le niveau qui la refuse, proxy (400) ou worker, est **À valider**.
- Le nombre de pixels n'est pas un champ : il se dérive du tableau validé, jamais d'un compteur fourni par le client (`docs/rate-limits.md`, section « Contrat validé »).
- Le proxy valide les bornes fixes et la palette, et répond 400 sinon (DRAW-01). Il ne lit pas Firestore. Côté Discord, le `command-worker` fait la même validation. Le `draw-worker` laisse DATA-02 seul juge des coordonnées, de la palette et du lot : un pixel invalide qui arriverait malgré tout est un message invalide (`400`, puis DLQ), pas un rejet métier.
- Le `canvas_version` n'est pas dans le payload : le worker le lit dans `config/global` au traitement, dans la transaction DATA-02 (ADR-0007 ; `docs/drawing-transactions.md`).

```json
{
  "pixels": [{ "x": 12, "y": -40, "color": 5 }]
}
```

### 3.3 `pixel-processed` et `pixel-rejected`

Les deux topics partagent le même `payload`, publié par le `draw-worker` après le commit de la transaction DATA-02 (`app/functions/draw-worker/src/result.ts`, type `DrawResultEvent`).

| Champ | Type | Obligatoire | Contrainte | Origine |
|---|---|---|---|---|
| `result` | object | oui | Résultat conservé `DrawResult` (`app/shared/src/drawing/command.ts`), décrit ci-dessous | DATA-02 |
| `discord` | object | si `source = discord`, interdit sinon | `DiscordContext` recopié du `pixel-draw`. **Contient le token d'interaction, secret.** | DRAW-02 ; BOT-05 |

Enveloppe :

- `event_id` : dérivé de l'événement source, UUID de forme v8 tiré du SHA-256 de `pixelwar:draw-result:v1:<event_id du pixel-draw>`. Un rejeu publie donc le même `event_id`.
- `correlation_id` : celui du `pixel-draw`.
- `occurred_at` : `result.processed_at`, la date du traitement conservé. Un rejeu republie la même date.
- `type` : égal à `result.type`.

Champs de `result` :

| Champ | Contrainte |
|---|---|
| `schema_version` | `1` |
| `result_id`, `event_id` | `event_id` est celui du `pixel-draw` source ; `result_id` vaut `draw-result:<event_id>` |
| `occurred_at`, `processed_at` | ISO 8601 UTC avec millisecondes |
| `source`, `uid` | Égaux à `source` et `actor.uid` de l'enveloppe |
| `canvas_version` | ≥ 1 |
| `type` | `pixel-processed` ou `pixel-rejected` |
| `requested_pixels` | Nombre de pixels du lot. Le nombre n'est jamais fourni par le client. |
| `applied_pixels`, `ignored_pixels` | `pixel-processed` : leur somme vaut `requested_pixels` ; un pixel ignoré a perdu face à un pixel plus récent (LWW). `pixel-rejected` : tous deux à `0`. |
| `regions` | Régions `rx_ry` réellement modifiées, triées ; vide pour un rejet |
| `reason` | Seulement pour `pixel-rejected` : voir ci-dessous |
| `quota` | Décision de quota (`RateLimitDecision`, `docs/rate-limits.md`) quand elle a été évaluée |

Motifs de rejet (`reason`) :

| Motif | Cause |
|---|---|
| `paused` | Dessin suspendu par `/admin pause` |
| `rate_limit` | Quota insuffisant ; le détail et le délai sont dans `quota` |
| `out_of_bounds` | Pixel hors des limites courantes de la grille (`config/global`) |
| `batch_budget_exceeded` | Le lot dépasserait le budget de documents d'une transaction |
| `expired` | Demande plus vieille que 14 jours (`MAX_DRAW_AGE_MS`) : rejeu tardif |

`invalid_pixel` n'est pas un motif de rejet : un pixel invalide est refusé avant publication (section 3.2). Le refus d'autorisation passe par `command-rejected` (section 3.7).

```json
{
  "result": {
    "schema_version": 1,
    "result_id": "draw-result:3f6c2a9e-1b7d-8e8f-9a52-6c0d4b7e1f20",
    "event_id": "3f6c2a9e-1b7d-8e8f-9a52-6c0d4b7e1f20",
    "occurred_at": "2026-11-13T10:15:30.123Z",
    "processed_at": "2026-11-13T10:15:30.987Z",
    "source": "web",
    "uid": "123456789012345678",
    "canvas_version": 3,
    "type": "pixel-processed",
    "requested_pixels": 1,
    "applied_pixels": 1,
    "ignored_pixels": 0,
    "regions": ["0_-1"]
  }
}
```

L'exemple correspond au pixel `(12, -40)` : `rx = floor(12 / 1024) = 0` et `ry = floor(-40 / 1024) = -1`, donc la région `0_-1` (`regionId(rx, ry)` renvoie `${rx}_${ry}`).

Le message ne contient jamais le détail d'une erreur technique ni d'une dépendance (`docs/observability.md`).

### 3.5 `render-requested` et `snapshot-requested`

Publiés par le `command-worker` pour `/get` et `/snapshot` (après autorisation pour `/snapshot`).

| Champ | Type | Obligatoire | Contrainte | Origine |
|---|---|---|---|---|
| `discord` | object | oui | `DiscordContext` de la section 3.1. **Contient le token d'interaction, secret**, valide 15 min. | BOT-04 ; BOT-06 ; BOT-07a |

La zone rendue n'est pas dans le message : elle est lue dans `config/global.bounds` au moment du rendu (DATA-05b). Proposition, à valider avec BOT-06.

```json
{
  "discord": {
    "application_id": "1000000000000000000",
    "interaction_id": "1100000000000000001",
    "guild_id": "1200000000000000000",
    "channel_id": "223344556677889900",
    "interaction_token": "<jeton d'interaction, secret>"
  }
}
```

### 3.6 `admin-requested`

Publié par le `command-worker` pour `/admin`, seulement si l'auteur est dans l'allow-list (utilisateurs ou rôles). Consommé par l'`admin-worker` (`docs/admin-worker.md`).

C'est le seul message, après `discord-command`, dont `actor` garde `roles` : l'`admin-worker` revérifie l'allow-list avant tout effet, et n'applique rien pour un auteur qui n'y figure plus.

| Champ | Type | Obligatoire | Contrainte | Origine |
|---|---|---|---|---|
| `options` | object | oui | `{ "subcommand": "pause" \| "resume" \| "clear" }`, `{ "subcommand": "ratelimit", "user": string, "limit": entier }` ou `{ "subcommand": "size", "width"?: entier, "height"?: entier }` | `AdminCommand` (`app/shared/src/events/discord.ts`) ; BOT-08 |
| `discord` | object | oui | `DiscordContext`, **secret** | BOT-04 |

### 3.7 `command-rejected`

Publié par le `command-worker` quand `/admin` ou `/snapshot` est demandé par un auteur hors allow-list. La commande n'est pas transmise au worker métier. Le `discord-notifier` remplace la réponse différée par un message de refus fixe. L'enveloppe reprend `event_id`, `correlation_id` et `occurred_at` du `discord-command`.

| Champ | Type | Obligatoire | Contrainte | Origine |
|---|---|---|---|---|
| `command` | string | oui | `admin` ou `snapshot` | BOT-04 |
| `reason` | string | oui | `unauthorized` | BOT-04 |
| `discord` | object | oui | `DiscordContext`, **secret** | BOT-04 |

### 3.8 `snapshot-ready` et `overview-tick`

Ces deux topics reçoivent des messages natifs, sans enveloppe métier. Leur format est décrit en sections 5 et 6.

## 4. Contrat HTTP des workers

### 4.1 Requête reçue

Pub/Sub envoie un `POST` en JSON. L'en-tête `Authorization` porte un token OIDC que Pub/Sub signe au nom du service account d'invocation du worker. Cloud Run vérifie ce token avant d'exécuter le code (ADR-0002, « Livraison en push avec un token OIDC »). Le worker n'écrit donc aucune logique d'authentification.

```json
{
  "message": {
    "data": "<JSON de l'enveloppe, encodé en base64>",
    "attributes": {
      "traceparent": "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
      "correlation_id": "c0a8013e-7d1f-4b6a-8e2d-9f3a5b7c1d40"
    },
    "messageId": "136969346945",
    "publishTime": "2026-11-13T10:15:30.456Z"
  },
  "subscription": "projects/<projet>/subscriptions/<abonnement>"
}
```

`message.messageId` et `subscription` viennent du ticket #28. `publishTime` est un champ standard de l'enveloppe push, non cité dans les sources du dépôt : à vérifier dans la documentation Pub/Sub.

Le worker est joignable par son URL `run.app` seulement. L'ingress est interne et l'IAM n'accorde `run.invoker` qu'au service account d'invocation du worker (ADR-0008, « Déclencheurs » ; ADR-0002). L'audience OIDC est l'URL `run.app` du worker, fixée explicitement dans l'abonnement (`oidc_token.audience`, `infra/serverless/discord-command.tf`).

### 4.2 Décodage et validation

Ordre des étapes dans le handler :

1. Ouvrir le span du message avec les attributs : `obs.message(event_type, message.attributes, …)` (`docs/observability.md`). Le `event_type` est le nom du topic (`pixel-draw`, etc.), comme dans les logs (`docs/observability.md`). Le span est ouvert avant la lecture du corps pour que même un message invalide reste corrélé (section 1.1).
2. Décoder `message.data` : `JSON.parse(Buffer.from(message.data, 'base64').toString('utf8'))`. Un corps absent ou non JSON rend le message invalide (section 8.3).
3. Valider l'enveloppe (section 1) et le `payload` du topic (section 3). Un `event_id` non UUID, un `occurred_at` qui ne respecte pas le format ou un champ manquant rendent le message invalide.
4. Traiter le message (section 8 pour l'idempotence).
5. Publier les résultats nécessaires.
6. Appeler `await obs.flush()` **avant** la réponse. En cas d'échec de l'export, écrire un log sans transformer le succès métier en échec (`docs/observability.md`).
7. Répondre.

### 4.3 Codes de retour

| Situation | Réponse | Effet côté Pub/Sub |
|---|---|---|
| Traitement durable terminé (écritures committées) et publications nécessaires faites | 2xx | Message acquitté. |
| Rejet métier attendu : pause, quota dépassé, coordonnée ou couleur invalide, hors grille, non autorisé | Publier l'événement de rejet (`pixel-rejected` ou équivalent), puis 2xx | Message acquitté. Ce n'est pas une erreur. |
| Erreur technique : Firestore indisponible, bug, échec d'une publication | Non-2xx (500) | Pas d'acquittement : nouvelle tentative avec backoff, puis DLQ (section 7). |
| Message au schéma invalide | 400 | Pas d'acquittement : nouvelles tentatives, puis DLQ, où l'alerte le rend visible (section 8.3). |
| Traitement qui dépasse le délai d'acquittement | Aucune réponse à temps (traitée comme un échec) | Message redélivré. Délai de 600 s au maximum en push (ADR-0002 ; #35). |

Règles :

- 2xx seulement après le commit et après les publications. Le ticket #46 demande d'« attendre les écritures et publications durables avant le 2xx ».
- Un rejet métier n'est pas une exception technique : il est enregistré, publié, puis acquitté (`docs/observability.md`).
- Aucun travail après la réponse. `cpu_idle = true` (`docs/observability.md`) : un travail resté en arrière-plan peut ne jamais s'exécuter. Ne pas supprimer le flush pour continuer en tâche de fond (`docs/observability.md`).
- Un échec d'export de télémétrie ne doit jamais provoquer un retry d'un traitement déjà commit (`docs/observability.md`).

## 5. Notifications GCS `OBJECT_FINALIZE`

Une notification Cloud Storage `OBJECT_FINALIZE` du bucket `snapshots` publie dans le topic `snapshot-ready`, par `google_storage_notification` (ADR-0002, « Sources qui ne sont pas des proxies » ; SRV-07). Le message n'a **pas** l'enveloppe de la section 1 : il n'y a ni `event_id`, ni `source`, ni `actor`.

Ce que le `snapshot-notifier` reçoit :

- le corps (`message.data`) : la ressource objet Cloud Storage au format JSON ;
- les attributs de notification, dont `eventType = OBJECT_FINALIZE`, `bucketId` et `objectId`, ainsi que `objectGeneration`.

Ces noms d'attributs et le contenu exact du corps viennent de la documentation Cloud Storage, non citée dans le dépôt : **à vérifier** avant implémentation.

Retrouver la corrélation : le `snapshot-worker` écrit les informations de la demande dans les métadonnées personnalisées de l'objet (BOT-07a : token d'interaction et canal). Le `snapshot-notifier` les lit dans la ressource objet (champ `metadata`) ou par une lecture de l'objet. Proposition : y ajouter aussi `correlation_id`, `event_id` de la demande et `interaction_id`, pour relier la notification à la trace de la commande (BOT-09). BOT-07a ne le demande pas explicitement.

Idempotence : le message n'a pas de `event_id`. La clé proposée est `bucketId` + `objectId` + `objectGeneration`. Une notification rejouée pour la même génération ne doit pas reposter le lien. Stockage de la trace d'envoi : **À valider**.

Le token d'interaction est un secret valide 15 min (BOT-05). Le stocker dans les métadonnées d'un objet est **À valider** (section 9).

## 6. Vue éloignée

Chaîne de déclenchement :

```text
Cloud Scheduler (job) ──publie──▶ topic overview-tick ──push OIDC──▶ overview-worker
```

Cloud Scheduler publie dans le topic à intervalle régulier ; l'abonnement pousse vers le worker, comme pour les autres événements (ADR-0002, « Sources qui ne sont pas des proxies » ; DATA-05c, « par exemple chaque minute »). Il n'y a ni Eventarc ni `event_trigger` (ADR-0002 ; ADR-0008, section « Déclencheurs »).

Le marquage des régions suit une autre chaîne :

```text
pixel-processed ──abonnement pixel-processed.overview-mark──▶ marquage des régions modifiées
overview-tick ──▶ overview-worker : re-rend les régions marquées, puis les niveaux 2 et 3 qui les contiennent
```

Les images sont écrites dans le bucket `overview` (SRV-07, DATA-05c). Les niveaux sont décrits dans ADR-0007, « Vue éloignée : une pyramide d'images ».

Points non tranchés, détaillés en section 9 :

- le stockage des régions marquées (collection, format) et sa remise à zéro ;
- la régénération complète après `/admin clear` (DATA-05c) : quel déclencheur ;
- le contenu du message Cloud Scheduler et le nom du topic ;
- le droit de publication de Cloud Scheduler sur le topic (ADR-0002 ne cite que le rôle de l'agent Cloud Storage).

## 7. Abonnements, DLQ et alertes

### 7.1 Abonnements

Convention proposée, reprise de `discord-command-verify` (`infra/serverless/discord-command.tf`) : l'abonnement porte le nom de son consommateur, suffixé du topic quand un consommateur en écoute plusieurs. Sa DLQ s'appelle `<abonnement>-dlq` et l'abonnement d'inspection de la DLQ `<abonnement>-dlq-inspect`.

| Abonnement | Topic | Worker (push) | Ticket |
|---|---|---|---|
| `command-worker` | `discord-command` | `command-worker` | BOT-04 |
| `draw-worker` | `pixel-draw` | `draw-worker` | DRAW-02 |
| `discord-notifier-processed` | `pixel-processed` | `discord-notifier` | BOT-05 |
| `overview-mark` | `pixel-processed` | Consommateur de marquage (nom à valider) | DATA-05c |
| `discord-notifier-rejected` | `pixel-rejected` | `discord-notifier` | BOT-05 |
| `discord-notifier-command-rejected` | `command-rejected` | `discord-notifier` | BOT-08 |
| `admin-worker` | `admin-requested` | `admin-worker` | BOT-08 |
| `render-worker` | `render-requested` | `render-worker` | BOT-06 |
| `snapshot-worker` | `snapshot-requested` | `snapshot-worker` | BOT-07a |
| `snapshot-notifier` | `snapshot-ready` | `snapshot-notifier` | BOT-07b |
| `overview-worker` | `overview-tick` | `overview-worker` | DATA-05c |

Le `discord-notifier` écoute deux topics : il a donc deux abonnements, qui pointent vers la même URL. Le filtre sur `source = discord` se fait dans le worker ou dans un filtre d'abonnement : **À valider** (section 9).

Chaque abonnement pousse vers l'URL `run.app` de son worker, avec un service account d'invocation dédié qui n'a `run.invoker` que sur ce worker (ADR-0002 ; #35).

### 7.2 Paramètres communs

| Paramètre | Valeur | Origine |
|---|---|---|
| DLQ | Un topic de DLQ par abonnement | SRV-05 ; ADR-0002 |
| Abonnement de debug sur la DLQ | Un par DLQ, pour inspecter et rejouer | SRV-05 |
| Nombre de tentatives avant DLQ | `max_delivery_attempts = 5` : **valeur approximative**, pas une garantie de cinq exécutions exactes | SRV-05 ; ADR-0002 (« 5 par défaut ») ; #35 |
| Backoff | Exponentiel, de 10 s à 60 s pour `discord-command-verify` ; à confirmer pour les autres workers | SRV-05 ; ADR-0002 ; `discord-command.tf` |
| Rétention | Au moins 7 jours | SRV-05 ; `docs/rate-limits.md` (« rejeu Pub/Sub/DLQ (7 jours prévus) ») |
| Délai d'acquittement | Aligné sur le timeout du worker (30 s pour `discord-command-verify`), 600 s au maximum en push | ADR-0002 ; #35 ; BOT-06 |
| Droits de l'agent Pub/Sub | `publisher` sur la DLQ, `subscriber` sur l'abonnement source | SRV-05 ; ADR-0002 |
| Droits du créateur d'abonnement | `iam.serviceAccounts.actAs` sur le service account d'invocation | ADR-0002 ; #35 |

### 7.3 Alertes

| Alerte | Seuil | Origine |
|---|---|---|
| DLQ non vide | Plus de 0 message, par abonnement | SRV-05 ; ADR-0002 ; OBS-02 |
| Âge du plus vieux message non acquitté (abonnement source) | Plus de 60 s | SRV-05 ; #35 |
| Taux d'erreur des workers du pipeline de dessin | Plus de 5 % | DRAW-05 |

## 8. Consommateurs : idempotence, ordre, messages invalides

Pub/Sub livre au moins une fois, sans ordre garanti. Chaque consommateur doit donc être idempotent. Ce catalogue ne suppose jamais une livraison exactement une fois (ADR-0002, « La livraison est « au moins une fois » »).

### 8.1 Idempotence par consommateur

| Consommateur | Clé d'idempotence | Comportement en cas de rejeu |
|---|---|---|
| `command-worker` | `interaction_id` (BOT-04) | Sans état : un rejeu republie le même message, avec le même `event_id` (section 3.2). Le doublon est absorbé par le consommateur, par exemple DATA-02 pour `pixel-draw`. |
| `draw-worker` | `event_id`, document `processed_events` (ADR-0007 ; `rate-limits.md`, étapes 1 à 4) | Dans la même transaction que les tuiles, les deltas et le compteur : le document de déduplication est lu en premier. S'il existe, le résultat d'origine est repris, sans réévaluer le quota ni écrire de pixel. |
| `admin-worker` | `event_id`, document `admin_events/<event_id>` écrit dans la même transaction que l'effet | Le résultat enregistré est repris : un `clear` relivré n'incrémente pas deux fois `canvas_version`. Même `event_id` avec une autre sous-commande : message invalide. La purge des anciennes tuiles reprend où elle s'était arrêtée. |
| `discord-notifier` | Aucune clé stockée : effet idempotent | Le `PATCH` de la réponse d'origine (`@original`, BOT-05) est rejoué avec le même contenu : le message reste identique, aucun second message n'est créé (`docs/discord-notifier.md`). |
| `render-worker` | `event_id` (proposition) | BOT-06 demande de tester qu'une nouvelle livraison ne produit pas de notification en double, mais ne fixe pas de mécanisme : **À valider**. |
| `snapshot-worker` | Clé d'objet stable par demande (BOT-07a, #54) | Proposition : `snapshots/<occurred_at de la demande>-<event_id>.png`, pour que le rejeu écrive le même objet. Le format exact est **À valider**. |
| `snapshot-notifier` | `bucketId` + `objectId` + `objectGeneration` (section 5) | Une notification rejouée ne doit pas reposter le lien (#55). Le stockage de la trace d'envoi est **À valider**. |
| Consommateur de marquage (vue éloignée) | Marquage idempotent par construction (proposition) | Marquer deux fois une région ne change rien. |
| `overview-worker` | Re-rendu depuis l'état courant (proposition) | Rejouable sans effet de bord. Les exécutions concurrentes sont **À valider**. |

Règle d'ordre LWW pour les tuiles : un événement rejoué ou en retard n'écrase jamais un pixel plus récent (DATA-02). La comparaison suit `compareEvents` : `occurred_at` d'abord, puis `event_id` en ordre ASCII des UUID en minuscules pour départager les égalités (`app/shared/src/grid/event-order.ts`). Les deltas suivent la même logique via `created_at` (ADR-0003).

### 8.2 Ordre

- Aucune garantie d'ordre entre messages d'un même topic ni entre topics (ADR-0002).
- Pas de clé d'ordre (`orderingKey`) : aucun ADR ne la justifie. La cohérence repose sur la règle LWW et sur la déduplication par `event_id`.

### 8.3 Messages invalides

Un message invalide est un message dont l'enveloppe, le `payload` ou le base64 ne respectent pas les sections 1 et 3. Ce cas n'est pas traité par ADR-0002, qui ne couvre que les rejets métier et les erreurs techniques.

Décision : le consommateur répond **400** (non-2xx). Le message est redélivré, puis part en DLQ ; l'alerte « DLQ non vide » (section 7.3) le rend visible. Un message invalide ne disparaît donc jamais sans trace, au prix de quelques tentatives inutiles. Le log ne contient que la raison (`invalid_envelope`, `invalid_data`, `invalid_event_schema`, `invalid_attributes`), jamais le corps. C'est le comportement de `discord-command-verify`.

Un rejet métier n'est jamais un message invalide : une coordonnée hors grille produit un `pixel-rejected` avec `out_of_bounds`.

## 9. À valider

Décisions que les sources ne tranchent pas. Chacune est à valider avant SRV-05 et les tickets workers.

1. **`source` et `actor` pour les événements système.** L'enum n'accepte que `discord` et `web`. Cloud Scheduler et Cloud Storage n'ont pas de valeur : ajouter `system` (et un `actor` technique), ou ne pas porter l'enveloppe sur ces messages ?
2. ~~**`event_id` dérivés du `command-worker`.**~~ Tranché par BOT-04 : le `pixel-draw` reprend l'`event_id` du `discord-command` (section 3.2).
3. ~~**`event_id` des résultats.**~~ Tranché par DRAW-02 : dérivé de `pixelwar:draw-result:v1:<event_id source>` (section 3.3).
4. **Publication fiable du résultat après commit.** `docs/rate-limits.md` indique que ce point reste ouvert : le résultat stocké doit être republié si le commit a réussi mais que la publication a échoué.
5. **Horizon de déduplication.** `docs/rate-limits.md` fixe un horizon de rejeu de 7 jours, ADR-0008 parle de 15 jours pour le bucket de sources. Les deux chiffres sont à aligner avec la rétention Pub/Sub (7 jours).
6. ~~**Motif `out_of_bounds`.**~~ Tranché par DATA-02 : motif de `pixel-rejected` à part entière (section 3.3). La liste des motifs de métrique de `docs/observability.md` reste à aligner.
7. **Coordonnée en double dans un lot** : refusée par le proxy (400) ou par le worker (`pixel-rejected`) ?
8. ~~**`canvas_version`.**~~ Tranché par DATA-02 : lu dans `config/global` pendant la transaction (section 3.2).
9. **Régions marquées** pour la vue éloignée : collection, format, remise à zéro, et déclencheur de la régénération complète après `/admin clear` (DATA-05c).
10. **Noms** : topic `overview-tick`, consommateur de marquage, et adoption de la convention de nommage des abonnements (section 7.1).
11. **Backoff** des autres workers ; `max_delivery_attempts = 5` reste approximatif.
12. **Droit de publication de Cloud Scheduler** sur `overview-tick` (non cité dans ADR-0002).
13. **Secrets dans les messages** : le `interaction_token` circule dans `discord-command`, `pixel-draw`, `pixel-processed`, `pixel-rejected`, `render-requested`, `snapshot-requested`, `admin-requested` et `command-rejected` (toujours dans `payload.discord`, jamais dans les attributs ni dans Firestore), et serait stocké dans les métadonnées de l'objet snapshot. Il est valide 15 min : une livraison retardée au-delà ne peut plus éditer le message. Le stocker dans GCS est-il acceptable ?
14. **`snapshot-ready`** : confirmer que le topic reste natif Cloud Storage, et ajouter `correlation_id` aux métadonnées de l'objet (BOT-07a ne le prévoit pas).
15. ~~**Rejeu tardif du `discord-notifier`.**~~ Tranché par BOT-05 : après 15 min, un log sûr est écrit et le message est acquitté (`204`) sans appeler Discord (`docs/discord-notifier.md`).
16. ~~**Filtre `source` du `discord-notifier`.**~~ Tranché par BOT-05 : dans le worker, qui acquitte un résultat web sans action.
17. **Idempotence des `render-worker` et `snapshot-worker`** : BOT-06 et BOT-07a demandent des tests, sans mécanisme (section 8.1).
18. **Délais des workers** : mémoire, timeout et délai d'acquittement de `render-worker` et `snapshot-worker`, à calibrer.
