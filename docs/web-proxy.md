# Proxy d'écriture web (DRAW-01)

## Périmètre et état

`app/functions/web-proxy/` fournit le handler HTTP Functions Framework
`handleWebProxy`, qui reçoit `POST /api/pixels` derrière la gateway. Cette
livraison est **locale, non déployée** : ni la fonction, ni le topic
`pixel-draw`, ni le backend `api` de la gateway ne sont déclarés en Terraform.

Le proxy valide la forme du lot, publie un message `pixel-draw` (catalogue des
événements, [section 3.2](events.md#32-pixel-draw)) et répond `202`. Il attend la
confirmation de Pub/Sub avant de répondre. Aucun traitement n'est lancé après la
réponse.

Il n'écrit pas Firestore et ne le lit pas. Le quota, la pause, la taille courante
de la grille et l'ordre des pixels sont appliqués par le `draw-worker` dans la
transaction DATA-02 ([drawing-transactions.md](drawing-transactions.md)).

## Authentification

La gateway valide le JWT de session (ADR-0012) et répond `401` sans invoquer la
fonction si le token est absent, expiré ou d'un autre projet. Elle transmet
ensuite les claims au proxy dans `X-Apigateway-Api-Userinfo`, encodés en base64.

Le proxy lit cet en-tête avec `gatewayIdentity`
(`app/shared/src/gateway/identity.ts`) : `sub` doit être un id Discord et `name`
un pseudo de 1 à 80 caractères, comme dans le JWT signé par l'`auth-proxy`. Un
en-tête absent ou invalide produit un `401` : il signale une route mal
configurée ou un appel qui a contourné la gateway.

Cet en-tête n'est digne de confiance que parce que seul le compte de la gateway
a `roles/run.invoker` sur la fonction (SRV-04b). Le même module servira à
`tile-reader` (SRV-11).

## Requête

```http
POST /api/pixels
Authorization: Bearer <JWT de session>
Content-Type: application/json

{ "pixels": [ { "x": 12, "y": -40, "color": 5 }, { "x": 13, "y": -40, "color": 5 } ] }
```

| Règle | Refus |
| --- | --- |
| Corps de 1 octet à 64 Kio | `413 invalid_body_size` |
| JSON UTF-8 valide | `400 invalid_json` |
| Objet avec la seule clé `pixels`, tableau non vide | `400 invalid_body` |
| Au plus 500 pixels (`DEFAULT_MAX_BATCH_PIXELS`) | `400 too_many_pixels` |
| Chaque pixel : exactement `x`, `y`, `color`, entiers ; `x` et `y` entre -10⁹ et 10⁹ ; `color` de 1 à 16 | `400 invalid_pixel` |
| Pas deux fois la même coordonnée | `400 duplicate_pixel` |

Le nombre de pixels compté par le quota est la longueur du tableau validé,
jamais un compteur fourni par le client. Un pixel hors de la taille courante de
la grille est accepté ici, puis rejeté par DATA-02 avec `out_of_bounds`.

Le refus d'une coordonnée en double se fait au proxy : DATA-02 la traite comme un
message invalide, qui partirait en DLQ au lieu de répondre à l'utilisateur.

## Réponses

| Situation | Réponse |
| --- | --- |
| Lot publié sur `pixel-draw` | `202 { "event_id", "correlation_id" }` |
| Identité absente ou invalide | `401 unauthenticated` |
| Lot refusé | `400` ou `413`, avec le code ci-dessus |
| Mauvais chemin ou méthode | `404 not_found`, `405 method_not_allowed` |
| Configuration incomplète | `503 unavailable` |
| Échec ou délai dépassé de la publication | `503 publish_unavailable` |

Le `202` signifie « accepté pour traitement », pas « dessiné ». Le résultat
arrive au navigateur par le flux temps réel : le delta si le dessin est appliqué,
ou le dernier rejet dans `users/{uid}` (événement `user`, DRAW-04).
L'`event_id` renvoyé permet au frontend de relier ce rejet à sa requête.

Un `503 publish_unavailable` après un délai dépassé est **incertain** : Pub/Sub a
pu accepter le message. Toutes les réponses portent `Cache-Control: no-store`.

## Identifiants et renvois

Chaque requête reçoit un `event_id` neuf (UUID v4), repris comme
`correlation_id`. `occurred_at` est l'heure du proxy : l'horloge du navigateur
n'est jamais utilisée, car elle départage les pixels concurrents (LWW).

Conséquence assumée : une requête renvoyée par le navigateur, par exemple après
une coupure réseau qui a perdu le `202`, est un **second dessin**. La grille ne
change pas visuellement (mêmes couleurs), mais le quota est compté deux fois et
un second delta est diffusé. Le frontend ne doit donc pas renvoyer
automatiquement une requête dont l'issue est incertaine.

Une clé d'idempotence fournie par le client a été écartée pour l'instant : DATA-02
ne déduplique que si `event_id` **et** `occurred_at` sont identiques, ce qui
obligerait à faire confiance à l'heure du navigateur. Elle reste possible plus
tard sans casser ce contrat.

## Auteur

`actor.uid` est le `sub` du JWT. `actor.name` est son `name`, tronqué à
32 caractères Unicode : DATA-02 refuse un nom d'auteur plus long dans les
métadonnées d'un pixel, alors que le JWT en accepte 80. Un pseudo Discord ne
dépasse pas 32 caractères : la troncature ne protège que d'un écart de contrat.

## CORS

Seule l'origine du frontend (`FRONTEND_ORIGIN`) reçoit
`Access-Control-Allow-Origin`. Le proxy répond lui-même au preflight `OPTIONS`
(`204`, méthode `POST`, en-têtes `Authorization` et `Content-Type`) et le refuse
(`403`) pour une autre origine, comme l'`auth-proxy`.

## Configuration du runtime

| Variable | Usage |
| --- | --- |
| `GOOGLE_CLOUD_PROJECT` | Projet qui porte le topic |
| `PIXEL_DRAW_TOPIC` | Topic `pixel-draw`, à provisionner séparément |
| `FRONTEND_ORIGIN` | Seule origine autorisée par CORS |
| `APP_ENV` | `dev` ou `prd`, pour l'export de télémétrie |

Une configuration incomplète produit un `503`. Aucun appel réseau n'est fait à
l'import. Le client Pub/Sub est créé au premier lot valide, avec un délai de
publication de 5 s et sans retry automatique.

## Observabilité

Chaque lot valide ouvre un span racine `web.pixels.draw` (SRV-08). Le contexte de
trace est créé par le proxy, jamais repris d'un en-tête du navigateur, puis
propagé dans les attributs Pub/Sub `correlation_id` et `traceparent`.

| `event_type` | Sévérité | Quand |
| --- | --- | --- |
| `web.proxy.published` | INFO | Publication confirmée |
| `web.proxy.refused.<code>` | WARNING | Requête refusée (`invalid_identity`, `invalid_body_size` ou code `400`) |
| `web.proxy.publish_failed` | ERROR | Échec de publication, issue incertaine |

Les logs ne contiennent ni le corps, ni l'en-tête d'identité, ni l'id Discord,
ni l'erreur du SDK Pub/Sub.

## Tests locaux

Depuis `app/` :

```sh
npx vitest run functions/web-proxy shared/src/gateway
```

Les tests couvrent la validation du lot, l'identité, le CORS, l'échec de
publication, le passage par le vrai Functions Framework, et le contrat avec le
`draw-worker` : le message publié est accepté par son parseur réel.

## Reste à faire avant la validation dev

- Déclarer en Terraform la fonction, son compte avec `roles/pubsub.publisher`
  sur `pixel-draw` uniquement, le topic `pixel-draw` (SRV-05) et le backend `api`
  exporté dans `gateway_contract` (la route est déjà déclarée dans
  `infra/gateway/routes.tf`).
- Vérifier en dev le format réel de `X-Apigateway-Api-Userinfo` et le `401` de
  la gateway sans JWT.
- Mesurer la latence de publication à froid.
