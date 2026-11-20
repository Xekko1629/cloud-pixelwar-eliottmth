# Lecteur de la grille pour le web (SRV-11)

## Périmètre et état

`app/functions/tile-reader/` fournit le handler HTTP Functions Framework
`handleTileReader`. Sans Firebase, le navigateur ne lit plus Firestore : ce proxy
est son seul chemin de lecture, derrière la gateway et avec le JWT de session
([ADR-0013](adr/0013-lectures-temps-reel-sans-firebase.md)). Cette livraison est
**locale, non déployée** : ni la fonction, ni son compte, ni le backend de la
gateway ne sont déclarés en Terraform.

Le proxy lit Firestore et n'écrit jamais : son compte d'exécution n'aura que
`roles/datastore.viewer`. Les écritures restent dans la transaction DATA-02.

| Route | Usage | Ticket client |
| --- | --- | --- |
| `GET /api/regions/{rx}/{ry}/tiles` | Couleurs des tuiles existantes d'une région, en binaire | WEB-03b |
| `GET /api/tiles/{tx}/{ty}/meta` | Auteur et date de chaque pixel d'une tuile | WEB-04 |
| `GET /api/state` | Configuration globale et quota de l'appelant | WEB-03b, DRAW-04 |

Les URL signées des images de la vue éloignée, prévues par le ticket, sont
**reportées** : le bucket `overview` (SRV-07) et les images (DATA-05c) n'existent
pas encore. Le temps réel n'est pas ici : il passe par le service `realtime`
(DRAW-06).

## Authentification

La gateway valide le JWT de session et répond `401` sans invoquer la fonction
sinon. Le proxy lit ensuite l'identité avec `gatewayIdentity`
(`app/shared/src/gateway/identity.ts`), comme le `web-proxy`
([web-proxy.md](web-proxy.md#authentification)). Un en-tête absent ou invalide
produit un `401` avant toute lecture.

`/api/state` ne lit que le document de l'appelant : l'id vient de la session,
jamais de l'URL.

## Coordonnées et version du canvas

Une région fait 1024 × 1024 pixels, soit 16 × 16 tuiles de 64 × 64
([ADR-0007](adr/0007-modele-donnees-grille.md)). Les coordonnées de l'URL sont des
entiers décimaux canoniques : `-0`, `+1`, `01` ou `1e3` donnent un `404`. Une
coordonnée hors de la grille de ±10⁹ pixels donne `400 invalid_coordinates`.

Chaque lecture commence par `config/global`, qui donne la version courante du
canvas. Après un `/admin clear`, la version change : les tuiles de l'ancienne
version ne sont plus servies, même avant leur purge.

## `GET /api/regions/{rx}/{ry}/tiles`

Réponse `application/octet-stream`, format du codec partagé
`app/shared/src/grid/region-codec.ts` :

```text
en-tête (7 octets) : format uint8 = 1 | canvas_version uint32 big-endian | nombre de tuiles uint16 big-endian
par tuile          : tx local uint8 (0..15) | ty local uint8 (0..15) | 4096 octets de couleurs
```

- Les couleurs suivent l'ordre des lignes de la tuile : l'octet `y × 64 + x`.
  `0` signifie « jamais peint », `1` à `16` sont les index de la palette.
- Les tuiles sont triées par ligne puis par colonne ; une tuile absente est vide.
- Une région pleine pèse environ 1 Mio. Si le navigateur annonce `gzip`, la
  réponse est compressée (`Content-Encoding: gzip`) : les zones vides valent zéro
  et se compressent très bien. `fetch` décompresse automatiquement.

Le frontend décode avec `decodeRegionTiles(bytes, rx, ry)`, qui refuse toute
réponse mal formée au lieu d'afficher une région partielle.

## `GET /api/tiles/{tx}/{ty}/meta`

```json
{
  "canvas_version": 3, "tx": 1, "ty": 0, "tile_side": 64,
  "pixels": { "129": { "name": "Eliott", "at": "2026-11-20T10:00:29.000Z" } }
}
```

- La clé est l'index du pixel dans la tuile (`y × 64 + x`) ; un pixel jamais
  peint est absent. Une tuile jamais peinte donne `pixels: {}`.
- `at` est l'heure de l'action (`occurred_at`), pas l'heure du traitement.
- **Seuls le pseudo et la date sont exposés.** L'id Discord de l'auteur et l'id
  d'événement, stockés par DATA-02, ne sortent pas : un utilisateur connecté ne
  peut pas collecter les ids Discord des autres.

## `GET /api/state`

```json
{
  "canvas_version": 3, "paused": false, "size": null, "bounds": null, "region_side": 1024,
  "user": {
    "limit_per_minute": 50, "used_pixels": 15, "remaining_pixels": 35,
    "reset_at": "2026-11-20T10:02:00.000Z",
    "last_rejection": { "event_id": "…", "reason": "paused", "at": "2026-11-20T10:01:03.000Z" }
  }
}
```

Le quota est calculé avec la même fonction que DATA-02 (`evaluateRateLimit`) :
limite personnelle de l'admin, sinon limite par défaut, et compteur remis à zéro
à chaque nouvelle minute. Le navigateur n'a donc pas à refaire ce calcul.
Cette réponse est une photo à l'instant de la lecture ; les mises à jour arrivent
ensuite par le flux `realtime` (DRAW-04).

`last_rejection` n'existe que si `users/{uid}` existe déjà : DATA-02 n'écrit pas
de refus pour un utilisateur qui n'a jamais dessiné.

## Cache

Chaque réponse réussie porte un `ETag` faible, empreinte SHA-256 du corps non
compressé, et `Cache-Control: private, no-cache` : le navigateur garde la réponse
mais la revalide à chaque usage. Si le contenu n'a pas changé, la réponse est
`304` sans corps.

L'`ETag` évite de renvoyer jusqu'à 1 Mio, **pas** les lectures Firestore : il faut
lire les données pour savoir si elles ont changé. Calculé sur le corps, il reste
exact même pour `/api/state`, dont le quota dépend de l'heure.

Les erreurs portent `Cache-Control: no-store`.

## Réponses d'erreur

| Situation | Réponse |
| --- | --- |
| Identité absente ou invalide | `401 unauthenticated` |
| Coordonnées hors de la grille | `400 invalid_coordinates` |
| Chemin inconnu, méthode autre que `GET` | `404 not_found`, `405 method_not_allowed` |
| Configuration incomplète du runtime | `503 unavailable` |
| Lecture impossible ou données incohérentes | `503 read_unavailable` |

Une donnée stockée incohérente (identifiant de tuile, couleurs, métadonnées ou
quota invalides) n'est jamais corrigée ni masquée : la lecture échoue en `503`.

## CORS

Seule l'origine du frontend (`FRONTEND_ORIGIN`) reçoit
`Access-Control-Allow-Origin` et `Access-Control-Expose-Headers: ETag`. Le proxy
répond au preflight `OPTIONS` (`204`, méthode `GET`, en-tête `Authorization`) et
le refuse (`403`) pour une autre origine.

## Configuration du runtime

| Variable | Usage |
| --- | --- |
| `GOOGLE_CLOUD_PROJECT` | Projet de la base Firestore `(default)` |
| `FRONTEND_ORIGIN` | Seule origine autorisée par CORS |
| `APP_ENV` | `dev` ou `prd`, pour l'export de télémétrie |

## Observabilité

Chaque lecture ouvre un span racine `tiles.region.read`, `tiles.meta.read` ou
`state.read`, et compte une tentative `outcome = served` ou `error` (SRV-08).

| `event_type` | Sévérité | Quand |
| --- | --- | --- |
| `tile_reader.refused.<code>` | WARNING | `invalid_identity` ou `invalid_coordinates` |
| `tile_reader.read_failed` | ERROR | Lecture impossible ; l'erreur n'est pas journalisée |

## Tests locaux

Depuis `app/` :

```sh
npx vitest run functions/tile-reader shared/src/grid/region-codec.test.ts
npm run test:integration   # dont store.integration.test.ts
```

Le test d'intégration écrit de vraies tuiles avec la transaction DATA-02 sur
l'émulateur Firestore, puis les relit avec le `tile-reader` : régions négatives,
changement de version, métadonnées sans id Discord, quota et dernier refus.

## Reste à faire avant la validation dev

- Terraform : fonction (`service_type = "proxy"`), compte avec
  `roles/datastore.viewer`, routes dans `infra/gateway/routes.tf` (auth `session`,
  `cors = true`) et backend exporté dans `gateway_contract`.
- Vérifier en dev que la gateway transmet `Content-Encoding: gzip`, `ETag` et le
  `304`, et le format réel de `X-Apigateway-Api-Userinfo`.
- URL signées de la vue éloignée, après SRV-07 et DATA-05c.
