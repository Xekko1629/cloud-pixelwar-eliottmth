# Catalogue des événements — ARCH-03

Ce catalogue décrit les messages échangés sur Pub/Sub entre les proxies, les workers et les sources externes (Cloud Storage, Cloud Scheduler). Le choix du broker Pub/Sub en push authentifié par OIDC est décrit dans [ADR-0002](adr/0002-broker-pubsub-push.md). Les workers sont des Cloud Run functions à ingress interne ([ADR-0008](adr/0008-compute-cloud-run-functions.md)).

Le topic `discord-command` (v1) est le premier contrat implémenté : `discord-proxy` le produit et le worker de diagnostic `discord-command-verify` le valide (`app/functions/`). Les autres topics sont fixés ici avant leur implémentation. Les points que les sources ne tranchent pas sont marqués **À valider** et repris dans la section 9.

Dans les tableaux, la colonne « Origine » indique la source du point : un ADR, un ticket (`#n`), un fichier du dépôt, ou « Proposition » (à valider).

## 1. Enveloppe métier

Chaque message métier porte l'enveloppe suivante, sérialisée en JSON UTF-8. En push, elle arrive encodée en base64 dans `message.data` (section 4).

| Champ | Type | Obligatoire | Format | Origine | Rôle |
|---|---|---|---|---|---|
| `schema_version` | entier | oui | `1` | `app/functions/discord-proxy/src/event.ts` | Version de l'enveloppe et du `payload`. Un consommateur refuse une version qu'il ne connaît pas. |
| `event_id` | string | oui | UUID canonique en minuscules, non nul | `app/shared/src/grid/event-order.ts` ; `event.ts` | Identifiant unique de l'événement, clé de déduplication (DATA-02). Pour `discord-command`, il est dérivé de l'interaction : UUID de forme v8 tiré du SHA-256 de `pixelwar:discord-command:v1:<application_id>:<interaction_id>`. Il est donc identique d'une livraison à l'autre. |
| `correlation_id` | string | oui | `^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$` | `app/shared/src/observability/context.ts` | Relie logs, spans et messages d'une même action (BOT-09, OBS-03). Généré par le proxy, jamais repris d'un client (`docs/observability.md`). Pour `discord-command`, égal à `event_id`. |
| `occurred_at` | string | oui | ISO 8601 UTC avec millisecondes : `AAAA-MM-JJTHH:MM:SS.mmmZ` | `event-order.ts` ; `event.ts` | Date de création de l'événement. Sert à la latence de bout en bout et à la règle last-write-wins (ADR-0002). Pour `discord-command`, c'est la date encodée dans l'id d'interaction Discord (snowflake). Voir la section 9 pour les événements système. |
| `source` | string | oui | `discord` ou `web` | ticket #28 | Origine de l'action. Les événements système (Cloud Scheduler, Cloud Storage) n'ont pas de valeur ici : **À valider**. |
| `actor` | object | oui | `{ "uid": string, "name": string, "roles": string[] }` | `event.ts` ; `uid` = id Discord (ADR-0012) | Auteur de l'action. `uid` est l'id Discord, `name` le pseudo au moment de l'action (repris dans les métadonnées de pixel, ADR-0007), `roles` les ids de ses rôles Discord, triés et sans doublon. Proposition pour le web : `roles` vide, les droits admin restant vérifiés par l'allow-list. |
| `payload` | object | oui | Schéma propre à chaque topic (section 3) | ticket #28 | Données métier. |

Le contexte de trace (`traceparent`) n'est **pas** dans le corps : il ne circule que dans les attributs Pub/Sub (section 1.1). Il n'existe donc qu'une source de vérité.

Exemple d'enveloppe (valeurs fictives, `payload` d'un `pixel-draw`) :

```json
{
  "schema_version": 1,
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
| `pixel-processed` | `draw-worker` | `discord-notifier` (filtré sur `source = discord`) ; consommateur de marquage de la vue éloignée | DRAW-02, BOT-05, DATA-05c |
| `pixel-rejected` | `draw-worker` | `discord-notifier` | DRAW-02, BOT-05 |
| `render-requested` | `command-worker` (`/get`) | `render-worker` | BOT-04, BOT-06 |
| `snapshot-requested` | `command-worker` (`/snapshot`) | `snapshot-worker` | BOT-04, BOT-07a |
| `snapshot-ready` | Cloud Storage : notification `OBJECT_FINALIZE` du bucket `snapshots` (message natif, sans enveloppe, section 5) | `snapshot-notifier` | SRV-07, BOT-07b |
| `overview-tick` (nom **à valider**) | Cloud Scheduler (message natif, section 6) | `overview-worker` | SRV-05, DATA-05c |

Un pixel posé sur le web n'est pas notifié par `pixel-rejected` : le dernier rejet et sa raison sont reportés dans `users/{uid}`, que le navigateur reçoit par l'événement `user` du flux `realtime` (DRAW-04 ; ADR-0013). Le nom du champ (par exemple `last_rejection`) est une proposition. Le topic `pixel-rejected` ne sert donc qu'au `discord-notifier`.

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

Contraintes complémentaires :

- Pas deux fois la même coordonnée dans un lot. Le code partagé la refuse (`app/shared/src/grid/batch.ts`, « Duplicate coordinate in draw batch »). Le niveau qui la refuse, proxy (400) ou worker, est **À valider**.
- Le nombre de pixels n'est pas un champ : il se dérive du tableau validé, jamais d'un compteur fourni par le client (`docs/rate-limits.md`, section « Contrat validé »).
- Le proxy valide les bornes fixes et la palette, et répond 400 sinon (DRAW-01). Il ne lit pas Firestore.
- Le `canvas_version` n'est pas dans le payload : proposition, le worker le lit dans `config/global` au traitement (ADR-0007). **À valider.**

```json
{
  "pixels": [
    { "x": 12, "y": -40, "color": 5 },
    { "x": 13, "y": -40, "color": 5 }
  ]
}
```

### 3.3 `pixel-processed`

| Champ | Type | Obligatoire | Contrainte | Origine |
|---|---|---|---|---|
| `pixel_count` | entier | oui | ≥ 1, égal au nombre de pixels du `pixel-draw` source | Proposition, à partir de `obs.pixels.processed(event.pixels.length, …)` (`docs/observability.md`) |
| `canvas_version` | entier | oui | ≥ 1 | `assertCanvasVersion` (`constants.ts`) ; `ProcessedEventDocument` (ADR-0007) |
| `regions` | array of string | oui | Au moins une région, format `rx_ry` | Format : `regionId` (`app/shared/src/grid/coordinates.ts`). Proposition : la liste est fournie pour le marquage de la vue éloignée. |

```json
{
  "pixel_count": 2,
  "canvas_version": 3,
  "regions": ["0_-1"]
}
```

L'exemple correspond aux pixels `(12, -40)` et `(13, -40)` : `rx = floor(12 / 1024) = 0` et `ry = floor(-40 / 1024) = -1`, donc la région `0_-1` (`regionId(rx, ry)` renvoie `${rx}_${ry}`).

### 3.4 `pixel-rejected`

| Champ | Type | Obligatoire | Contrainte | Origine |
|---|---|---|---|---|
| `reason` | string | oui | `paused`, `rate_limit`, `invalid_pixel`, `unauthorized` ou `out_of_bounds` | `paused`, `rate_limit`, `invalid_pixel`, `unauthorized` : `docs/observability.md`. `out_of_bounds` : ADR-0007 et DRAW-02. Voir la section 9 sur `out_of_bounds`. |
| `sub_reason` | string ou null | oui | Renseigné seulement si `reason = rate_limit` : `insufficient_quota`, `batch_exceeds_limit` ou `drawing_disabled`, sinon `null` | `docs/rate-limits.md`, tableau des refus métier. Proposition de structure. |
| `pixel_count` | entier | oui | ≥ 1 | Idem `pixel-processed` |
| `retry_after_seconds` | entier ou null | oui | Secondes avant la minute suivante pour `insufficient_quota` ; `null` sinon | `docs/rate-limits.md`, tableau des refus métier |

Le message ne contient jamais le détail d'une erreur technique ni d'une dépendance (`docs/observability.md`).

```json
{
  "reason": "rate_limit",
  "sub_reason": "insufficient_quota",
  "pixel_count": 5,
  "retry_after_seconds": 18
}
```

### 3.5 `render-requested`

| Champ | Type | Obligatoire | Contrainte | Origine |
|---|---|---|---|---|
| `interaction_token` | string | oui | **Secret**, valide 15 min | BOT-06 (message de suivi) ; BOT-05 |
| `channel_id` | string | oui | Id du canal | BOT-06 |

La zone rendue n'est pas dans le message : elle est lue dans `config/global.bounds` au moment du rendu (DATA-05b). Proposition, à valider avec BOT-06.

```json
{
  "interaction_token": "<jeton d'interaction, secret>",
  "channel_id": "223344556677889900"
}
```

### 3.6 `snapshot-requested`

Mêmes champs que `render-requested` : `interaction_token` (secret) et `channel_id`. Ces deux champs suffisent au `snapshot-worker` pour ranger le token et le canal dans les métadonnées de l'objet (BOT-07a).

```json
{
  "interaction_token": "<jeton d'interaction, secret>",
  "channel_id": "223344556677889900"
}
```

### 3.7 `snapshot-ready` et `overview-tick`

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
| `command-worker` | `interaction_id` (BOT-04) | Ne publie ni second `pixel-draw` ni second `render-requested`. Le rejeu exige que les `event_id` dérivés soient déterministes : **À valider** (section 9). |
| `draw-worker` | `event_id`, document `processed_events` (ADR-0007 ; `rate-limits.md`, étapes 1 à 4) | Dans la même transaction que les tuiles, les deltas et le compteur : le document de déduplication est lu en premier. S'il existe, le résultat d'origine est repris, sans réévaluer le quota ni écrire de pixel. |
| `discord-notifier` | `event_id` (proposition) | Le `PATCH` de la réponse d'origine (BOT-05) est rejoué avec le même contenu : il reste identique. Proposition. |
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
2. **`event_id` dérivés du `command-worker`.** Un `pixel-draw` publié à partir d'un `discord-command` rejoué ne doit pas avoir un second `event_id`. Proposition : même méthode que `discord-proxy`, avec le préfixe `pixelwar:pixel-draw:v1:<event_id source>`.
3. **`event_id` des résultats** (`pixel-processed`, `pixel-rejected`) : réutiliser celui du `pixel-draw` source, ou en dériver un nouveau ?
4. **Publication fiable du résultat après commit.** `docs/rate-limits.md` indique que ce point reste ouvert : le résultat stocké doit être republié si le commit a réussi mais que la publication a échoué.
5. **Horizon de déduplication.** `docs/rate-limits.md` fixe un horizon de rejeu de 7 jours, ADR-0008 parle de 15 jours pour le bucket de sources. Les deux chiffres sont à aligner avec la rétention Pub/Sub (7 jours).
6. **Motif `out_of_bounds`.** ADR-0007 et DRAW-02 l'utilisent comme motif de `pixel-rejected`, la liste des motifs de métrique (`docs/observability.md`) ne le contient pas. L'ajouter, ou le classer dans `invalid_pixel` ?
7. **Coordonnée en double dans un lot** : refusée par le proxy (400) ou par le worker (`pixel-rejected`) ?
8. **`canvas_version`** : lu par le worker dans `config/global` (proposition) ou porté par le message ?
9. **Régions marquées** pour la vue éloignée : collection, format, remise à zéro, et déclencheur de la régénération complète après `/admin clear` (DATA-05c).
10. **Noms** : topic `overview-tick`, consommateur de marquage, et adoption de la convention de nommage des abonnements (section 7.1).
11. **Backoff** des autres workers ; `max_delivery_attempts = 5` reste approximatif.
12. **Droit de publication de Cloud Scheduler** sur `overview-tick` (non cité dans ADR-0002).
13. **Secrets dans les messages** : le `interaction_token` circule dans `discord-command`, `render-requested` et `snapshot-requested`, et serait stocké dans les métadonnées de l'objet snapshot. Il est valide 15 min : une livraison retardée au-delà ne peut plus éditer le message. Le stocker dans GCS est-il acceptable ?
14. **`snapshot-ready`** : confirmer que le topic reste natif Cloud Storage, et ajouter `correlation_id` aux métadonnées de l'objet (BOT-07a ne le prévoit pas).
15. **Rejeu tardif du `discord-notifier`** : si la redélivrance arrive après 15 min, le `PATCH` échoue. Quel comportement attendu ?
16. **Filtre `source` du `discord-notifier`** : dans le worker ou par filtre d'abonnement.
17. **Idempotence des `render-worker` et `snapshot-worker`** : BOT-06 et BOT-07a demandent des tests, sans mécanisme (section 8.1).
18. **Délais des workers** : mémoire, timeout et délai d'acquittement de `render-worker` et `snapshot-worker`, à calibrer.
