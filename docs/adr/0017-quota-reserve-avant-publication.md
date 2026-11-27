# ADR-0017 · Quota réservé avant la publication des pixels web

- **Statut** : Proposé
- **Date** : 2026-11-27
- **Tickets** : DRAW-05 (#64), DRAW-01 (#58), DATA-03 (#42), WEB-05 (#71), OBS-05a (#77). Modifie la partie « Quotas » d'[ADR-0014](0014-un-evenement-par-pixel.md) et le « Contrat transactionnel de l'appelant » de [`docs/rate-limits.md`](../rate-limits.md) pour la source `web`.
- **Références** : Sujet §3.3 et §4 · [Contention des transactions Firestore](https://firebase.google.com/docs/firestore/transaction-data-contention) · [Quotas Firestore](https://cloud.google.com/firestore/quotas) · [Ingress Cloud Run](https://cloud.google.com/run/docs/securing/ingress) · [Authentification de service à service](https://cloud.google.com/run/docs/authenticating/service-to-service) · [`docs/draw-throughput.md`](../draw-throughput.md)

## Contexte

- Chaque transaction de groupe du `draw-worker` lit et écrit `users/{uid}`, le compteur
  de quota du joueur. Firestore ne valide qu'une transaction à la fois sur un même
  document : les autres attendent son verrou ou sont annulées, puis rejouées.
- Mesures en dev le 27/11, un seul compte, au pinceau web
  ([détail](../draw-throughput.md)) :

  | Réglage | Débit | Lecture de `users/{uid}`, médiane / p90 | Transactions réussies du premier coup |
  | --- | --- | --- | --- |
  | 5 instances × 32, reprises du SDK (14:08) | ≈ 12 px/s | 14 / 193 ms | 19 % |
  | 5 instances × 128, reprises rapides (15:09) | ≈ 22 px/s | 234 / 1 344 ms | 34 % |
  | 2 instances × 128, reprises rapides (15:20) | ≈ 40 px/s | 32 / 121 ms | 42 % |

  Les tuiles restent rapides (40 ms en médiane à 15:09). **Moins d'instances donne plus
  de débit** : le document `users/{uid}` est le goulot, et ajouter des instances ne fait
  qu'ajouter des collisions. La montée en charge que le sujet demande de prouver (§4)
  est donc impossible tant que le worker écrit ce document.
- Plusieurs joueurs ne règlent pas le problème : un groupe contient les pixels de
  plusieurs joueurs, donc deux instances qui ont chacune un pixel du même joueur se
  bloquent aussi.
- Un tracé web arrive en requêtes de 1 à 500 pixels (ADR-0014). Réserver le quota
  **une fois par requête** remplace environ 4 à 30 écritures concurrentes de
  `users/{uid}` (une par groupe) par une seule.
- `/draw` sur Discord produit un pixel par commande humaine : il ne crée jamais de
  point chaud.

## Décision

### 1. Un service `quota-reserver`, appelé par `web-proxy`

- Nouvelle fonction HTTP `quota-reserver`, avec son propre compte de service et
  `roles/datastore.user`. C'est la seule nouvelle fonction qui écrit dans Firestore.
- `web-proxy` reste **sans accès Firestore**. Il valide la requête comme aujourd'hui,
  appelle `quota-reserver` avec un ID token de son compte de service, puis publie
  **uniquement les pixels accordés**, un événement `pixel-draw` par pixel (ADR-0014
  inchangé sur ce point).
- Entrée de `quota-reserver` : `{ reservation_id, uid, pixel_count }`.
  `reservation_id` est le `correlation_id` de la requête web. Sortie : `{ granted,
  refused, reason?, retry_after_seconds, limit_per_minute, remaining_pixels, reset_at }`
  ([détail](../quota-reserver.md)).

### 2. Accès : par l'identité, pas par le réseau

- Ingress `ALLOW_ALL`, comme les proxies derrière la gateway (ADR-0008), et
  `roles/run.invoker` accordé **seulement** au compte de service de `web-proxy`.
  Tout autre appel, avec ou sans token, reçoit `403` de Cloud Run avant notre code.
- Un ingress interne (`ALLOW_INTERNAL_ONLY`) refuserait aussi les appels de
  `web-proxy`, qui n'a pas de sortie VPC. Ajouter une sortie VPC aux deux fonctions
  est une défense en profondeur possible plus tard (voir « Options écartées »).
- La gateway n'a **aucune route** vers `quota-reserver`.

### 3. Une règle : les N premiers pixels de la requête

- Le service lit `config/global`, `ratelimit_overrides/{uid}` et `users/{uid}`, puis
  appelle le calcul pur de `rate-limit.ts` avec `pixel_count = min(demandés, restants)`.
- **Accord partiel** : s'il reste 300 pixels pour une requête de 500, les 300
  **premiers** pixels de la requête, dans l'ordre du tableau envoyé, sont accordés et
  publiés ; les 200 suivants sont refusés (`insufficient_quota`) et jamais publiés.
  Le premier pixel du tracé passe donc toujours avant le dernier, contrairement au
  mode actuel où l'ordre de livraison décidait.
- Refus complet si la limite est nulle (`drawing_disabled`) ou s'il ne reste rien
  (`insufficient_quota`, avec `retry_after_seconds`). Si `config/global.paused` est
  vrai, refus `paused` sans consommer de quota.
- Chaque réservation écrit `users/{uid}` (compteur, `last_rejection` mis à jour comme
  le fait aujourd'hui le worker) dans **une** transaction.

### 4. Une reprise ne réserve pas deux fois

- `users/{uid}.last_reservation = { id, granted, at }`. Si `web-proxy` renvoie le même
  `reservation_id` (reprise après une erreur réseau), le service rend le même accord
  sans recompter.
- Une nouvelle requête du navigateur reçoit un nouveau `correlation_id`, donc une
  nouvelle réservation : c'est déjà la règle d'ADR-0014 (« une reprise HTTP est un
  second dessin »).

### 5. Le `draw-worker` ne recompte plus le quota des pixels web

- Pour `source = web`, le worker fait confiance à la réservation : seul `web-proxy`
  peut publier sur `pixel-draw` (IAM du topic, inchangée). Il ne lit plus
  `ratelimit_overrides/{uid}` ni le compteur de `users/{uid}` pour ces pixels, et ne
  l'écrit plus quand ils sont acceptés.
- Il garde ses autres règles, évaluées au moment du traitement : pause, bornes de
  la toile, âge maximal, déduplication, last-write-wins.
- S'il refuse un pixel web pour une de ces raisons, il écrit encore
  `users/{uid}.last_rejection` (le frontend en a besoin, WEB-05). C'est rare et ne
  touche pas le chemin normal.
- **Discord ne change pas** : pour `source = discord`, le worker applique le quota
  comme aujourd'hui, dans sa transaction. Les deux chemins partagent la même règle
  (`rate-limit.ts`) et le même compteur `users/{uid}`, toujours modifié dans une
  transaction.

### 6. Pas de remboursement

- Un pixel accordé puis refusé par le worker (pause activée entre-temps, pixel trop
  vieux, hors de la toile) ou parti en DLQ garde son quota consommé. Rembourser
  remettrait des écritures sur `users/{uid}` dans le worker, ce que cette décision
  supprime.

### 7. Réponse de `POST /api/pixels`

- `202` : `{ correlation_id, event_ids, refused? }`. `event_ids` ne contient que les
  pixels accordés, dans l'ordre de la requête. `refused = { count, reason,
  retry_after_seconds }` est présent seulement en cas d'accord partiel.
- `429` : rien n'est accordé. Corps `{ error: reason, retry_after_seconds }`, en-tête
  `Retry-After` si une attente suffit.
- `503` si `quota-reserver` ne répond pas : rien n'est publié, aucun quota n'est
  consommé s'il n'a pas répondu, ou il est retrouvé par `reservation_id` à la reprise.

## Options écartées

| Option | Pourquoi elle est écartée |
| --- | --- |
| Garder le quota dans le worker, avec moins d'instances | Mesuré : 2 instances donnent 40 px/s pour un joueur, et ajouter des instances ralentit. Aucune preuve de scalabilité possible. |
| Réserver dans `web-proxy` directement | Il lui faudrait `roles/datastore.user`, qui ne se limite pas à une collection : un service exposé derrière la gateway pourrait écrire toute la base. |
| `quota-reserver` en ingress interne, avec une sortie VPC pour `web-proxy` | Plus fermé côté réseau, mais ajoute un connecteur ou une sortie VPC directe, des règles réseau et un coût. L'IAM reste de toute façon le vrai contrôle. À reconsidérer si l'équipe le juge nécessaire. |
| Faire passer aussi `/draw` Discord par `quota-reserver` | Un pixel par commande humaine ne crée pas de contention. Ce serait un appel réseau de plus dans un parcours qui doit répondre vite, et environ 80 lignes de plus, sans gain mesurable. |
| Rembourser le quota des pixels refusés par le worker | Remet des écritures de `users/{uid}` dans le worker. |
| Compteurs de quota répartis sur plusieurs documents | Rendent le quota approximatif et la transaction plus complexe (déjà écarté par ADR-0014). |
| Refuser toute la requête si le quota ne suffit pas | Plus simple, mais un tracé commencé est perdu en entier pour quelques pixels de trop. Le frontend réduit déjà le tracé au quota restant (`fetchUserQuota`) : l'accord partiel ne sert qu'en cas de course, et garde le début du trait. |

## Conséquences

- **Débit attendu**, à mesurer (OBS-05a) : environ 100 à 200 px/s pour un seul joueur,
  et environ 50 à 150 px/s par instance avec des joueurs différents. Ajouter des
  instances doit enfin augmenter le débit.
- **Limite suivante** : `processed_events` et `deltas` ont un champ de date indexé qui
  ne fait que croître ; Firestore les limite à environ 500 écritures par seconde
  chacune. Au-delà, il faut exclure ces champs de l'index.
- **`config/global` reste lu par chaque transaction**, et écrit quand un pixel agrandit
  les bornes de la toile (`bounds`). Un tracé qui sort sans cesse des bornes déjà
  dessinées peut donc encore créer de la contention : à surveiller dans les mêmes
  champs de log (`read_people_ms`, `attempts`).
- **Latence** : un appel de plus par requête web, environ 50 à 100 ms, et un
  démarrage à froid d'environ 1 à 2 s au premier tracé après une pause. Le refus de
  quota devient immédiat dans la réponse HTTP.
- **Sécurité** : une fonction de plus avec un accès Firestore, petite, sans route
  publique, appelable par un seul compte de service.
- **Règles de quota** : `docs/rate-limits.md` gardait le quota dans la transaction de
  dessin pour toutes les sources. C'est maintenant vrai pour Discord seulement ; pour
  le web, la réservation est une transaction séparée, avant la publication.
- **Tests** : les tests d'équivalence du regroupement (`group.test.ts`) gardent le
  quota pour Discord ; de nouveaux tests couvrent la réservation, l'accord partiel,
  la reprise et un worker qui n'écrit plus `users/{uid}` pour un pixel web accepté.
