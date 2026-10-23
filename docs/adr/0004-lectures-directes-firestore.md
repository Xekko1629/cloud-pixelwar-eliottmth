# ADR-0004 · Lectures directes de Firestore depuis le navigateur

- **Statut** : Proposé
- **Date** : 2026-10-23
- **Tickets** : ARCH-01 (#26). Utilisé par SRV-06, DRAW-03a, DRAW-04, WEB-03b, WEB-04, DATA-05c.
- **Références** : Sujet §3.1, §3.4 · C07 §3.3, §4, §5

## Contexte

Le sujet (§3.4) demande : « All API calls from the frontend must be authenticated and pass through the same gateway + event pipeline (no direct writes to storage). »

Avec l'ADR-0003, le navigateur lit pourtant Firestore directement, sans passer par la gateway :

- les **tuiles** (couleurs) du viewport ;
- les **métadonnées** d'une tuile, quand on inspecte un pixel ;
- les **deltas** temps réel ;
- `config/global` et son propre document `users/{uid}`.

Il faut donc justifier cet écart apparent, et prévoir une solution de repli si l'encadrant le refuse.

## Décision

1. **Toutes les écritures** passent par le chemin imposé : gateway → proxy → Pub/Sub → worker. Le navigateur n'écrit jamais dans Firestore ni dans un bucket.
2. **Les lectures** listées ci-dessus se font directement avec le SDK Firestore web, authentifiées par l'ID token Firebase de l'utilisateur (ADR-0005).
3. Les **règles de sécurité Firestore** (SRV-06), versionnées et déployées par la pipeline, garantissent :
   - `allow write: if false` sur toutes les collections ;
   - lecture réservée aux utilisateurs connectés, et seulement sur les collections exposées : tuiles, métadonnées, deltas, `config/global` ;
   - `users/{uid}` lisible uniquement par son propriétaire (`request.auth.uid == uid`) ;
   - rien d'autre n'est lisible : déduplication, compteurs de rate limit, overrides admin.
4. Les workers accèdent à Firestore par les bibliothèques serveur, avec leur service account. Ces bibliothèques ne passent pas par les règles de sécurité : ce sont les rôles IAM qui limitent leurs droits.
5. Les images de la vue éloignée (DATA-05c) suivent le même principe : lecture seule et authentifiée, par les règles Firebase Storage ou par des URL signées délivrées via la gateway. Le choix se fera dans DATA-05c.

## Justification

- **La règle vise les écritures.** La phrase du sujet parle de passer par le « event pipeline », qui n'existe que pour les écritures (une lecture ne produit aucun événement), et précise entre parenthèses « no direct writes to storage ». C07 §4 la reformule ainsi : « No direct writes to storage from the browser », et C07 §5 range parmi les erreurs classiques les « direct client writes bypassing the gateway/queue ».
- **Les supports le prévoient.** C07 §3.3 cite les « Firestore real-time listeners (GCP) » comme canal temps réel. Un listener Firestore est, par construction, une lecture directe depuis le navigateur.
- **Les lectures restent authentifiées.** Le même ID token Firebase est vérifié par API Gateway pour les écritures, et par les règles Firestore pour les lectures. Un visiteur non connecté ne lit rien.
- **Le temps réel n'a pas d'alternative déployable en IaC.** Faire passer les deltas par la gateway demanderait son mode streaming, en Preview et non pris en charge par Terraform (ADR-0003).
- **C'est plus performant.** Le SDK met en cache, se reconnecte seul et regroupe les requêtes. Charger quelques centaines de tuiles ne fait pas démarrer de proxy, ni compter autant d'appels à la gateway.

## Plan B

- **Tuiles et métadonnées** : une route `GET /api/tiles/{tx}/{ty}` (et `/meta`) derrière la gateway, servie par un `tile-reader` Cloud Run qui a seulement le droit de lire Firestore. Les réponses sont cachables (`Cache-Control`, ETag sur `updated_at`). Le frontend change de fournisseur de tuiles, le reste ne bouge pas (WEB-03b prévoit déjà un fournisseur interchangeable).
- **Deltas** : il n'existe pas d'autre canal temps réel déployable en Terraform. En dernier recours, ce serait le mode streaming d'API Gateway, créé hors de Terraform et documenté comme exception.

## Conséquences

- Les règles Firestore font partie de la surface de sécurité : on les teste comme du code, sur l'émulateur, avec des cas qui doivent être refusés (écriture, lecture sans authentification, lecture du document `users` d'un autre). À ajouter au socle de tests (TEST-01).
- La clé d'API web de Firebase, publique par nature, est restreinte aux domaines du frontend et aux seules APIs nécessaires (ADR-0005).
- Le diagramme (ARCH-02) montre ce flux de lecture séparément du flux d'écriture, avec son mécanisme d'authentification.
- Les lectures Firestore apparaissent dans le dashboard applicatif (OBS-02), pour repérer un abus ou un coût anormal.

## En soutenance

- « Toutes les écritures passent par la gateway et la file. Les lectures se font directement dans Firestore, avec le même token, et les règles de sécurité interdisent toute écriture depuis le navigateur. »
- « Le support C07 cite les listeners Firestore comme solution de temps réel : c'est une lecture directe par définition. »
