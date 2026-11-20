# ADR-0013 · Lectures et temps réel sans SDK Firebase

- **Statut** : Proposé (exception d'accès public du flux temps réel à valider avec l'encadrant)
- **Date** : 2026-11-19
- **Tickets** : SRV-06 (#36), DRAW-03a (#61), DRAW-03b (#62), DRAW-04 (#63), WEB-03b (#67), WEB-03c (#68), WEB-04 (#70), DATA-05c (#47). Remplace [ADR-0004](0004-lectures-directes-firestore.md) et le côté lecture de [ADR-0003](0003-temps-reel-listeners-firestore.md).
- **Références** : Sujet §3.1, §3.4 · C06 §7 · C07 §3.3 · [Cloud Run : requêtes longues et streaming](https://cloud.google.com/run/docs/triggering/websockets)

## Contexte

- Sans Firebase, le navigateur ne peut plus utiliser le SDK web Firestore : plus
  de lectures directes de tuiles, ni de listeners `onSnapshot` côté client
  (ADR-0003, ADR-0004).
- Firestore reste la base de données. Les fonctions y accèdent avec
  `@google-cloud/firestore` et leur compte de service, sans `firebase-admin`.
- Le côté écriture de l'ADR-0003 ne change pas : le `draw-worker` écrit les tuiles
  et un document `deltas` par région touchée dans la même transaction.
- Le temps réel reste obligatoire et le polling interdit (§3.4). Le mode
  streaming d'API Gateway est en Preview et ne se déploie pas en Terraform.

## Décision

### Lectures ponctuelles : derrière la gateway

- Un proxy de lecture **`tile-reader`** (Cloud Run function, rôle
  `roles/datastore.viewer`) sert, derrière la gateway et avec le JWT de session :
  - `GET /api/regions/{rx}/{ry}/tiles` : les tuiles existantes d'une région, en
    un appel, au format binaire compact du codec partagé ;
  - `GET /api/tiles/{tx}/{ty}/meta` : les métadonnées d'une tuile (inspection, WEB-04) ;
  - `GET /api/state` : `config/global` et le document `users/{uid}` de l'appelant.
- Réponses cachables (`ETag` sur `updated_at`, `Cache-Control: private`).
- Toutes les lectures du navigateur passent donc par la gateway : l'écart
  apparent de l'ADR-0004 disparaît.

### Temps réel : un service de flux SSE

- Un service Cloud Run **`realtime`** (image Docker, même pipeline que le
  frontend, ADR-0011) expose `GET /stream?regions=…` en **Server-Sent Events**.
- Il valide lui-même le JWT de session (même émetteur, mêmes clés publiques que
  la gateway, ADR-0012) avant d'ouvrir le flux.
- Chaque instance ouvre **un listener Firestore côté serveur** par région suivie
  (requête `deltas` de l'ADR-0003 : `canvas_version`, `region`, `created_at > T0`)
  et le partage entre tous ses clients ; elle écoute aussi `config/global`, et
  `users/{uid}` pour chaque client connecté.
- Le client lit le flux avec `fetch` et un `ReadableStream` (l'en-tête
  `Authorization` est impossible avec `EventSource`). Il applique les règles 2 à 4
  de l'ADR-0003 (deltas plus récents que `updated_at`, recréation du flux quand
  le viewport change).
- Reprise (DRAW-03b) : à la reconnexion, le client envoie le `created_at` du
  dernier delta reçu ; au-delà du TTL des deltas, il recharge les tuiles visibles.
- Paramètres : `timeout = 3600 s`, concurrence élevée (par exemple 500),
  `max_instance_count` plafonné, compte de service `realtime` avec
  `roles/datastore.viewer` seulement.
- Le service est appelé directement par le navigateur (accès `allUsers` au
  niveau Cloud Run, authentification dans le code). C'est la seconde exception à
  « tout passe par la gateway », justifiée par l'absence de streaming déployable
  en Terraform sur API Gateway : **à valider avec l'encadrant**.

## Options écartées

| Option | Pourquoi elle est écartée |
|---|---|
| Listeners Firestore dans le navigateur (ADR-0003) | Exigent le SDK web Firebase, exclu par la revue intermédiaire. |
| Mode streaming d'API Gateway | En Preview, et non configurable par Terraform. |
| WebSocket au lieu de SSE | Le flux est descendant uniquement ; SSE passe par HTTP standard et se reconnecte simplement. |
| Un appel par tuile 64×64 | Un viewport couvre des centaines de tuiles : autant d'appels facturés à la gateway. La lecture par région les regroupe. |
| Polling | Interdit (§3.4). |

## Conséquences

- Moins de lectures Firestore facturées : un delta est lu une fois par instance
  `realtime`, pas une fois par navigateur abonné.
- Un service à état de connexion : une instance reste active tant qu'un client
  est connecté ; les connexions sont coupées au plus tard après 60 min et le
  client se reconnecte.
- Deux points d'entrée hors gateway au total (frontend et `realtime`) : SEC-01
  les liste comme seules exceptions `allUsers`.
- Les règles de sécurité Firestore ne sont plus une surface d'attaque : aucun
  client ne parle à Firestore. Les index et le TTL des deltas passent en
  Terraform (`google_firestore_index`, `google_firestore_field`), sans
  `firebase.json`.
- Si l'encadrant refuse l'accès direct à `realtime`, la seule alternative
  restante est le mode streaming d'API Gateway, créé hors Terraform et documenté
  comme exception.
