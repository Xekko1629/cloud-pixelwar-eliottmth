# ADR-0014 · Dessin : un événement Pub/Sub par pixel

- **Statut** : Proposé
- **Date** : 2026-11-20
- **Tickets** : DRAW-01 (#58), DRAW-02 (#46), DATA-02 (#41), DATA-03 (#42), WEB-05 (#71), BOT-04 (#51), DRAW-05 (#64), OBS-05a (#77). Modifie la partie « Écriture » d'[ADR-0007](0007-modele-donnees-grille.md) et l'unité des deltas d'[ADR-0003](0003-temps-reel-listeners-firestore.md).
- **Références** : Sujet §3.4 · C07 §3.6 · C08 §8 · séance du 20/11/2026 (frontend) · [Contention des transactions Firestore](https://firebase.google.com/docs/firestore/transaction-data-contention) · [Batching du client Pub/Sub](https://cloud.google.com/pubsub/docs/batch-messaging)

## Contexte

- Jusqu'ici, le topic `pixel-draw` transportait un **lot** de 1 à 500 pixels. Le
  `draw-worker` traitait le lot dans une seule transaction, et un lot qui
  dépassait le quota était refusé en entier (ADR-0007, `docs/rate-limits.md`).
- Lors de la séance du 20/11, l'encadrant a précisé la consigne du brush :
  - un endpoint qui reçoit la liste des pixels d'un trait est accepté ;
  - chaque pixel doit ensuite être republié comme **un événement individuel**
    sur le topic des pixels : le brush produit une rafale d'événements unitaires ;
  - il ne veut pas voir de fonction qui écrit des pixels par lot ;
  - le brush sert à mesurer, dans le monitoring, le débit en **pixels par seconde
    et par instance** : 50 est faible, 200 correct, 600 à 2 000 très bien.
- C07 §3.6 écrit « batch the changed pixels into events ». La consigne orale est
  plus récente et plus précise : on la suit.
- Un trait de brush vient d'un seul utilisateur et touche peu de tuiles (un trait
  de 50×50 couvre au plus 4 tuiles de 64×64). Dans Firestore, les transactions qui
  écrivent le même document s'exécutent l'une après l'autre. Une transaction par
  pixel ferait donc attendre les 2 500 pixels du trait sur `users/{uid}` et sur ces
  quelques tuiles.

## Décision

### API web : une liste par requête, un événement par pixel

- `POST /api/pixels` accepte toujours **1 à 500 pixels** par requête
  (`DEFAULT_MAX_BATCH_PIXELS` devient le plafond **par requête HTTP**). Un trait
  plus long est découpé en plusieurs requêtes par le frontend.
- Le `web-proxy` valide toute la requête (bornes, palette, coordonnées en double)
  et répond `400` si un seul pixel est invalide. Il ne lit pas Firestore.
- Il publie ensuite **un message `pixel-draw` par pixel** :

  | Champ | Valeur |
  |---|---|
  | `event_id` | UUID propre à chaque pixel, généré par le proxy |
  | `correlation_id` | Le même pour tous les pixels de la requête : un trait est une seule action, qu'on suit de bout en bout |
  | `occurred_at` | L'heure de réception de la requête, la même pour tous les pixels |
  | `payload` | `{ "x": …, "y": …, "color": … }` |

- La publication passe par le batching du client Pub/Sub : plusieurs messages
  partagent une même requête de publication. C'est un regroupement de transport ;
  chaque message reste distinct, acquitté, réessayé et envoyé en DLQ séparément.
- Le proxy répond `202` avec le `correlation_id` seulement quand **toutes** les
  publications sont confirmées. Si l'une échoue, il répond `503`. Les pixels déjà
  publiés restent valides ; si le client renvoie la requête, ils sont redessinés
  et recomptés dans le quota, ce qui est acceptable.
- Discord ne change pas : `/draw` produit un seul pixel, que le `command-worker`
  publie comme un message `pixel-draw`.

### Worker : chaque événement a son propre résultat

- Un message = un pixel = une déduplication par `event_id`, un résultat
  (`pixel-processed` ou `pixel-rejected`) et un acquittement.
- **Mode de base**, à implémenter d'abord : une transaction par message, qui suit
  le contrat de `docs/rate-limits.md` avec `pixel_count = 1`.
- **Regroupement d'écriture par instance** (*group commit*), activé seulement si
  le test de charge du mode de base reste sous 200 pixels par seconde et par
  instance. **Activé le 26/11/2026** : le mode de base a mesuré 3,7 pixels par
  seconde pour 2 instances sur un trait de 500 pixels (dev). Le regroupement suit
  l'option « au fil de l'eau » : une transaction à la fois par instance, et le groupe
  suivant réunit les pixels arrivés pendant celle-ci (sans fenêtre d'attente). Si le
  commit échoue, chaque pixel est rejoué seul par l'instance avant de répondre
  (`docs/draw-worker.md`). Détail du principe :
  - Les requêtes push qu'une même instance reçoit en parallèle (concurrence
    Cloud Run) attendent au plus quelques dizaines de millisecondes, ou un nombre
    maximal de pixels fixé par le budget de tuiles et de documents.
  - Une seule transaction les applique : déduplication de chaque `event_id`, quota
    évalué pixel par pixel dans l'ordre `compareEvents`, règle last-write-wins par
    pixel, tuiles groupées, un delta par région.
  - Chaque requête ne reçoit son `2xx` qu'après le commit. Si le commit échoue,
    l'instance rejoue chaque pixel seul avec la transaction du mode de base ; seul
    un pixel qui échoue encore répond `500` et est redélivré seul.
  - Le broker transporte toujours un événement par pixel, et aucun message n'est
    acquitté avant que son pixel soit durable. Le regroupement ne change que la
    façon dont le worker écrit dans Firestore. Ce n'est pas l'« écriture par
    lot » écartée par l'encadrant : aucun événement ne contient plusieurs
    pixels, et un pixel en échec est réessayé seul.
- Deux événements d'un même groupe peuvent viser la même coordonnée : le worker
  ne garde que le gagnant selon `compareEvents` avant d'appeler
  `groupPixelsByTile` et `groupPixelsByRegion`, qui refusent les doublons.

### Quotas

> Pour la source `web`, remplacé par [ADR-0017](0017-quota-reserve-avant-publication.md) : le quota est réservé une fois par requête, avant la publication. Ce qui suit reste vrai pour `/draw` Discord.

- Chaque pixel est évalué seul. Pour un trait plus long que le quota restant, les
  premiers pixels traités passent et les suivants sont rejetés avec
  `insufficient_quota`. Dans le mode de base, l'ordre de livraison n'étant pas
  garanti, les pixels acceptés ne sont pas forcément ceux du début du trait.
- `batch_exceeds_limit` ne s'applique plus : un pixel seul ne dépasse jamais une
  limite d'au moins 1. Une limite nulle donne toujours `drawing_disabled`.
- Le calcul pur de `rate-limit.ts` ne change pas. Il est appelé avec
  `pixel_count = 1`, éventuellement plusieurs fois dans la même transaction.

### Résultats et deltas

- `pixel-processed` et `pixel-rejected` sont publiés **pour chaque pixel**.
- Un delta reste « un document par transaction et par région ». Dans le mode de
  base, il ne contient donc qu'un pixel.

## Options écartées

| Option | Pourquoi elle est écartée |
|---|---|
| Un lot de pixels dans un seul événement (contrat précédent) | Contraire à la consigne de l'encadrant du 20/11. |
| Une requête HTTP par pixel | Un trait de 50×50 deviendrait 2 500 appels facturés à la gateway, chacun avec sa latence. La consigne autorise une liste par requête. |
| Abonnement Pub/Sub en pull, traité par lots par un worker permanent | On perd le scale à zéro et le scaling piloté par les requêtes (ADR-0002). C'est en plus une écriture par lot côté consommateur. |
| Compteurs de quota répartis sur plusieurs documents | Ils lèvent le point chaud de `users/{uid}`, mais rendent le quota approximatif et la transaction plus complexe. Le regroupement d'écriture règle le même problème. |

## Conséquences

- Le nombre de messages est multiplié par la taille du trait. Le batching du
  client Pub/Sub limite le nombre de requêtes de publication. À suivre dans le
  dashboard du pipeline (DRAW-05, OBS-02).
- **Mode de base** : chaque trait se sérialise sur `users/{uid}` et sur ses
  tuiles. La collection `deltas`, indexée sur un `created_at` qui ne fait que
  croître, est aussi limitée à environ 500 écritures par seconde (ADR-0003).
  Ce mode a donc de bonnes chances de rester dans la zone « faible » de
  l'encadrant. Il sert de référence pour le test de charge (OBS-05a).
- **Regroupement d'écriture** : une transaction et un delta par région pour
  chaque groupe. C'est le mode qui peut viser 200 pixels par seconde et par
  instance, puis davantage. À mesurer avant la soutenance.
- La métrique à montrer en soutenance est le nombre de pixels traités par seconde
  et par instance du `draw-worker` (DRAW-05).
- Le `users/{uid}.last_rejection` lu par le frontend décrit le dernier pixel
  rejeté. Le frontend agrège ces rejets pour afficher un message par trait (WEB-05).
