# `/snapshot` : image horodatée et URL signée (BOT-07a, BOT-07b)

## Chaîne

Celle imposée par le sujet (§5.4) :

```text
/snapshot → discord-proxy → discord-command → command-worker (admins seulement)
  → snapshot-requested → snapshot-worker → PNG dans le bucket privé snapshots
  → OBJECT_FINALIZE → snapshot-ready → snapshot-notifier → URL signée dans la réponse Discord
```

Le proxy répond tout de suite « en cours » (`type: 5`). La réponse différée est ensuite
modifiée (`@original`) par le worker si la toile est vide ou trop grande, sinon par le
notifier avec le lien.

## `snapshot-worker`

- Rend la zone peinte comme `/get` (DATA-05b, `app/shared/src/render/canvas.ts`), avec
  `SNAPSHOT_RENDER_OPTIONS` : jusqu'à 4096 px de côté, sans limite d'envoi Discord.
- Écrit **d'abord** la fiche `requests/<event_id>.json`, **puis** l'image
  `snapshots/<date de l'interaction>_<event_id>.png` (ISO-8601, `:` et `.` remplacés
  par `-`). Quand Cloud Storage signale l'image, sa fiche existe déjà.
- Chaque objet est créé avec la précondition « n'existe pas encore » : une relivraison
  ne crée ni seconde image ni seconde fiche (`snapshot.already_stored`). Le compte n'a
  que `roles/storage.objectCreator` : il ne peut ni lire, ni réécrire, ni supprimer.
- Un token déjà expiré (15 min) : rien n'est rendu.

## Où va le token d'interaction

Dans la fiche `requests/<event_id>.json` (`app/shared/src/snapshot/`), avec `event_id`,
`correlation_id`, `traceparent`, l'application et la date de l'interaction.

**Jamais dans les métadonnées de l'image** : Cloud Storage renvoie les métadonnées
personnalisées en en-têtes `x-goog-meta-*` à chaque téléchargement, y compris par l'URL
signée postée dans le canal. Tout membre pourrait alors lire le token et, pendant ses
minutes restantes, modifier ou poster des messages au nom du bot. L'image ne porte que
`event_id` et `canvas_version`.

La fiche est privée : seuls le worker (création) et le notifier (lecture) ont un droit
sur le bucket `snapshots`. Une règle d'expiration la supprime après un jour ; le token,
lui, expire après 15 minutes. Mettre la fiche dans Firestore l'aurait exposée à toutes
les fonctions qui lisent Firestore (droits par projet, pas par collection).

## `snapshot-notifier`

- Reçoit la notification native `OBJECT_FINALIZE` (attributs `bucketId`, `objectId`,
  `objectGeneration`, format `JSON_API_V1`). La notification est filtrée sur
  `snapshots/` ; un autre objet est de toute façon acquitté sans action.
- Relit la fiche, vérifie qu'elle correspond à l'image et à l'application, continue la
  trace de la commande, signe une URL V4 de lecture **valable 24 heures**, et modifie la
  réponse d'origine.
- Une notification rejouée modifie le même message (lien re-signé) : jamais un second
  message.
- Signature sans clé : `roles/iam.serviceAccountTokenCreator` sur **son propre** compte
  (API `signBlob`) et `roles/storage.objectViewer` sur le bucket `snapshots` seulement.

| `event_type` | Sévérité | Quand |
| --- | --- | --- |
| `snapshot.stored` / `snapshot.already_stored` | INFO | Image créée, ou déjà créée par une livraison précédente |
| `snapshot.empty` / `snapshot.too_large` | INFO / WARNING | Pas d'image : réponse directe du worker |
| `snapshot.notification_expired` | WARNING | Token expiré avant le rendu |
| `snapshot.failed`, `snapshot.message.invalid` | ERROR, WARNING | `503` (nouvelle tentative), `400` (puis DLQ) |
| `snapshot_notifier.posted` | INFO | Lien posté |
| `snapshot_notifier.ignored` | INFO | Objet qui n'est pas une image de snapshot |
| `snapshot_notifier.request_missing` / `request_invalid` | WARNING | Fiche absente (expirée) ou inutilisable : acquitté sans relance |
| `snapshot_notifier.expired` / `unknown_interaction` | WARNING | Discord n'accepte plus la modification |
| `snapshot_notifier.failed`, `snapshot_notifier.message.invalid` | ERROR, WARNING | `503`, `400` |

Aucun log ne contient le token ni l'URL signée.

## Qui peut utiliser `/snapshot`

Les admins seulement, pour l'instant : allow-list vérifiée par le `command-worker`, et
`default_member_permissions: "0"` à l'enregistrement. Le sujet (§3.2) ne le restreint pas,
C07 le réserve aux admins : **question posée à l'encadrant**. L'ouvrir à tous se fait dans
`app/functions/command-worker/src/route.ts`.

## Profil

| Fonction | Mémoire | Requêtes par instance | Instances max | Timeout | Délai d'acquittement |
| --- | --- | --- | --- | --- | --- |
| `snapshot-worker` | 1 Gio | 1 | 2 | 300 s | 330 s |
| `snapshot-notifier` | 512 Mio | 8 | 2 | 30 s | 60 s |

Images conservées 7 jours (`snapshot_retention_days`), fiches 1 jour.

## Activer en dev

1. Deploy (même drapeaux que `/get`), puis `npm run discord:commands -- --snapshot`
   et `--apply --confirm-application-id …`.
2. `/snapshot` par un admin : logs `snapshot.stored` puis `snapshot_notifier.posted`,
   même trace dans Cloud Trace.
3. Le lien ouvre l'image ; l'URL publique de l'objet
   (`https://storage.googleapis.com/<bucket>/<objet>`) répond `403`.
4. `curl -s -D - -o /dev/null "<lien>"` (un `GET` : l'URL est signée pour cette méthode) : aucun en-tête `x-goog-meta-` ne contient de token.
5. `/snapshot` par un non-admin : refus immédiat, aucun objet créé.

## Tests

```sh
npx vitest run functions/snapshot-worker functions/snapshot-notifier shared/src/snapshot
npm run test:integration   # dont testing/snapshot.integration.test.ts
```

Le test sur émulateur part d'un vrai dessin DATA-02 et d'une commande routée par le vrai
`command-worker`, rend l'image, puis fait relire la fiche par le notifier. Le bucket y est
simulé : signature, précondition et notification réelles restent à vérifier en dev.
