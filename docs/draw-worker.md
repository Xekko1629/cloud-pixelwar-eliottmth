# Draw worker : consommer, dessiner, publier

## Responsabilité

`app/functions/draw-worker`, entrée `handleDrawWorker`, adapte un message Pub/Sub
`pixel-draw` au moteur partagé DATA-02. Web et Discord empruntent exactement le
même traitement : pause, dimensions, quota, tuiles, deltas et résultat durable.
Le worker ne fait aucun appel Discord et ne réimplémente pas les règles métier.

Ordre obligatoire : valider le message → transaction DATA-02 → publication
confirmée du résultat → réponse `204`. Aucun travail après la réponse.

## Entrée `pixel-draw` v1

Le type `PixelDrawEvent` est exposé par `@pixelwar/shared/events` :

```json
{
  "schema_version": 1,
  "type": "pixel-draw",
  "event_id": "11111111-1111-4111-8111-111111111111",
  "correlation_id": "22222222-2222-4222-8222-222222222222",
  "occurred_at": "2026-11-19T10:00:30.000Z",
  "source": "web",
  "actor": { "uid": "123456789012345678", "name": "Exemple" },
  "payload": { "pixels": [{ "x": 0, "y": 0, "color": 2 }] }
}
```

Le message est enveloppé dans le format push Pub/Sub, avec l'abonnement attendu,
un `messageId` et du base64 canonique contenant du JSON UTF-8 strict.
Le corps brut est limité à 128 Kio, le champ base64 à 64 Kio avant décodage.
Les UUID sont non nuls et canoniques en minuscules. L'auteur est identifié par
son ID Discord, également pour le web authentifié.

Les attributs sont exactement `correlation_id` et `traceparent` W3C valide,
sampled ou non. Le premier doit correspondre à l'enveloppe métier ; le contexte
est restauré dans un span consommateur SRV-08, puis propagé avec le nouvel ID de
span. Les tests en mémoire vérifient les liens ; ils ne prouvent pas l'ingestion GCP.

Pour `source: discord`, `payload.discord` doit contenir l'application,
l'interaction, le serveur, le canal et le token attendus. L'ID de l'événement et
sa date sont vérifiés contre l'interaction comme dans BOT-03/BOT-04. L'application
doit correspondre à la configuration. Un événement web ne peut pas contenir ce
contexte Discord. Les données de notification ne sont jamais transmises au moteur
DATA-02 et ne sont pas enregistrées dans ses documents Firestore.

Chaque message porte **exactement un pixel** (ADR-0014) : un message avec 0 ou
plusieurs pixels est refusé (`400`) avant tout appel à DATA-02. Le moteur DATA-02
garde sa capacité de lot, réservée à un éventuel regroupement d'écriture par
instance (ADR-0014), qui n'est pas implémenté. DATA-02 valide les coordonnées
techniques, couleurs et auteurs. Un lot mal formé est une entrée invalide, pas
un dessin partiellement accepté. Un pixel techniquement valide mais hors des
dimensions configurées produit en revanche le refus métier `out_of_bounds`.

## Sortie et reprise après panne

Le type partagé `DrawResultEvent` contient :

- `type: pixel-processed` ou `pixel-rejected` ;
- un `event_id` UUIDv8 stable dérivé de `pixelwar:draw-result:v1:<event_id source>` ;
- le `correlation_id` de la demande et `occurred_at` égal au `processed_at` conservé ;
- `source`, `actor` et `payload.result`, le résultat durable DATA-02 ;
- uniquement pour Discord, `payload.discord` pour le futur notifier.

`payload.result.event_id` désigne la demande originale. Son `result_id` interne
`draw-result:<event_id source>` reste disponible ; l'ID d'enveloppe du résultat
est distinct et conforme au format UUID. Les consommateurs doivent dédupliquer
leurs effets grâce à cet ID stable.

Si la publication échoue après commit, répondre non-2xx. À la livraison suivante,
DATA-02 relit le résultat sans redessiner ni recompter le quota ; le worker
republie ce même résultat. Une publication réussie suivie d'une panne avant le
2xx peut donner deux messages, mais leurs IDs et résultats métier sont identiques.
Le token et le contexte de trace ne participent pas à l'empreinte de déduplication.

Un refus est également durable : après `resume` ou changement de dimensions,
la même demande reste refusée. Pour tenter un nouveau dessin, il faut une nouvelle
demande avec un nouvel `event_id`.

## Réponses et confidentialité

| Cas | Réponse |
| --- | --- |
| Résultat accepté ou refus métier, publication confirmée | `204` |
| Enveloppe, encodage, contrat ou lot mal formé | `400` |
| Configuration absente, état Firestore invalide, conflit d'ID, horloge future, panne SDK ou publication | `503` |
| Corps brut absent/trop grand | `413` |
| Chemin/méthode inattendu | `404` / `405` |

Les non-2xx permettent les retries puis la DLQ selon le futur abonnement.
Un token, un nom utilisateur, des pixels ou un objet `Error` SDK ne sont jamais
loggés. Les logs ne contiennent que des champs techniques sélectionnés.
Le token reste sensible dans Pub/Sub, y compris dans les résultats et DLQ :
restreindre leurs lecteurs et ne pas publier de corps brut dans les preuves.

## Configuration

| Variable | Usage |
| --- | --- |
| `GOOGLE_CLOUD_PROJECT` | Projet Firestore/Pub/Sub |
| `PIXEL_DRAW_SUBSCRIPTION` | Nom complet de l'abonnement source |
| `DISCORD_APPLICATION_ID` | Application attendue ; obligatoire pour les demandes Discord |
| `PIXEL_PROCESSED_TOPIC` | Nom court du topic des succès |
| `PIXEL_REJECTED_TOPIC` | Nom court du topic des refus métier |

Sans application configurée, le web reste traitable et les demandes Discord
échouent en `503`, sans écriture. Un topic absent échoue à la publication,
sans acquittement ; le résultat déjà commité reste reprenable.
Les clients Firestore et Pub/Sub sont initialisés au premier besoin et réutilisés.
Le RPC de publication est borné à 5 secondes sans retry SDK, pas le cold start total.

La configuration `config/global`, les index et politiques TTL DATA-02 doivent
être provisionnés séparément. Ne pas créer de configuration par défaut depuis
le worker pour contourner un environnement incomplet.

## Concurrence et regroupement d'écriture

Profil du Terraform dev (`infra/serverless/draw-path.tf`) :

```hcl
service_type    = "worker"
concurrency     = 32
min_instances   = 0
max_instances   = var.draw_worker_max_instances   # 5 par défaut, de 1 à 10
timeout_seconds = 300
cpu             = "1"
memory          = "512Mi"
```

**Pourquoi 32.** Le profil de départ était `concurrency = 1`. Mesuré en dev le
26/11 (un trait de 500 pixels), il traitait 3,7 pixels par seconde : chaque pixel
était une transaction qui attendait la précédente sur `users/{uid}` et sur sa tuile,
et Cloud Run refusait les autres livraisons (« no available instance »), d'où des
relivraisons et un pixel en DLQ. Le traitement réel d'un pixel ne prenait que 0,2 s.

Mesures avant et après : [protocole de mesure du débit](draw-throughput.md).

**Regroupement d'écriture** ([ADR-0014](adr/0014-un-evenement-par-pixel.md)) :

- Une instance n'exécute qu'**une** transaction à la fois
  (`app/shared/src/drawing/group-commit.ts`).
- Un pixel qui trouve l'instance libre part tout de suite, seul, avec la transaction
  d'origine : aucune attente ajoutée quand l'activité est faible.
- Les pixels qui arrivent pendant une transaction forment le groupe suivant, au plus
  32 (`MAX_DRAW_GROUP`, égal à la concurrence). Le groupe est appliqué en **une**
  transaction (`app/shared/src/drawing/group.ts`) : `users/{uid}`, chaque tuile,
  `config/global` et un delta par région ne sont écrits qu'une fois.
- Chaque pixel garde son message Pub/Sub, sa déduplication par `event_id`, sa
  décision de quota dans l'ordre `compareEvents`, son résultat et son acquittement.
  Le résultat d'un groupe est identique à celui de transactions successives dans cet
  ordre (test d'équivalence de `group.test.ts`).
- Si la transaction du groupe échoue (tuile corrompue, budget dépassé, contention
  persistante), l'instance rejoue chaque pixel **seul**, l'un après l'autre : un pixel
  défectueux n'échoue que sa propre requête, que Pub/Sub relivre seule.

Logs d'un groupe, une ligne par transaction (pas par pixel) :

| `event_type` | Sévérité | Quand |
| --- | --- | --- |
| `draw.group.committed` | INFO | Un groupe de `group_size` pixels a été écrit en une transaction |
| `draw.group.fallback` | WARNING | Le groupe a échoué ; ses `group_size` pixels sont rejoués un par un |

Champs de ces deux lignes, pour savoir où passe le temps d'un groupe :

| Champ | Sens |
| --- | --- |
| `group_size` | Pixels du groupe |
| `wait_ms` | Attente du plus vieux pixel du groupe dans l'instance, le temps que la transaction précédente finisse |
| `attempts` | Tentatives de la transaction ; plus de 1 : Firestore l'a annulée (contention) et le SDK l'a rejouée |
| `read_processed_ms` | Lecture des `processed/{event_id}` (déduplication), dernière tentative |
| `read_people_ms` | Lecture de `config/global`, des `users/{uid}` et des surcharges de quota, dernière tentative |
| `read_tiles_ms` | Lecture des tuiles, dernière tentative (0 si aucun pixel n'arrive jusqu'aux tuiles) |
| `transaction_ms` | Durée totale de la transaction, reprises comprises |

Exemple de requête Cloud Logging :
`resource.labels.service_name="draw-worker" AND jsonPayload.event_type="draw.group.committed" AND jsonPayload.attempts>1`.

Un pixel traité seul n'écrit pas de ligne de groupe. Chaque pixel garde son log
`draw.result.published`. Le débit par instance de DRAW-05 se lit sur ces logs et sur
la métrique de tentatives du worker.

**Pourquoi 5 instances.** Une instance ne fait qu'une transaction à la fois, soit
environ 10 pixels par seconde (dev, 27/11 : 19 à 24 px/s avec 2 instances saturées,
et 1 291 refus `429` « no available instance » pendant 4 tracés de 500 pixels). Le
débit se règle donc en instances : 5 instances, c'est environ 50 px/s, soit environ
150 joueurs au quota par défaut de 20 pixels par minute.

Le coût suit le nombre de pixels, pas le plafond : 500 pixels prennent environ
50 secondes d'instance, sur 2 comme sur 5 instances. Le plafond borne seulement
l'heure la plus chère, environ 0,2 $ par instance saturée, Firestore compris (ordre
de grandeur, tarifs publics à revérifier). Au repos, `min_instances = 0` ne coûte
rien. Au-delà de 10, la validation refuse : revoir d'abord le budget
(`docs/gcp.md`).

La démonstration de montée en charge change seulement
`draw_worker_max_instances` (2, puis 4, puis 5) ; voir le
[protocole de mesure](draw-throughput.md). Le passage à l'échelle n'est linéaire que
si les pixels viennent de joueurs différents : chaque transaction écrit
`users/{uid}`, donc un seul joueur sur plusieurs instances crée de la contention
(`draw.group.fallback`).

Le timeout total et les reprises
doivent rester compatibles avec le token Discord de 15 minutes (tentatives avant la
DLQ : `docs/events.md`, section 7.2).

L'abonnement `draw-worker` à 330 s et `roles/datastore.user` pour le runtime.
Voir le [déploiement dev du parcours `/draw`](deploy-draw-path.md).

## Tests

Depuis `app/` : `npm run typecheck`, `npm run test:coverage`,
`npm run test:integration`, `npm run build:functions`.

Les tests émulateurs exercent DATA-02 et publient les résultats dans Pub/Sub local :
doublons simultanés, événement ancien, pause/reprise, limites de grille, quota,
panne avant confirmation et succès incertain après publication. L'entrée Discord
est produite par le vrai routeur BOT-04 en test ; aucun token réel n'est utilisé.
Les tests HTTP utilisent le vrai Functions Framework. Aucun de ces tests ne
valide les droits IAM/OIDC, le nettoyage TTL cloud ou la charge de production.
