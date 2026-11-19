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
est propagé sans inventer de span Cloud Trace.

Pour `source: discord`, `payload.discord` doit contenir l'application,
l'interaction, le serveur, le canal et le token attendus. L'ID de l'événement et
sa date sont vérifiés contre l'interaction comme dans BOT-03/BOT-04. L'application
doit correspondre à la configuration. Un événement web ne peut pas contenir ce
contexte Discord. Les données de notification ne sont jamais transmises au moteur
DATA-02 et ne sont pas enregistrées dans ses documents Firestore.

DATA-02 valide les coordonnées techniques, couleurs, auteurs et lots, avec
500 pixels maximum par défaut. Un lot mal formé est une entrée invalide, pas
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

## Concurrence : profil initial à valider en dev

Profil prudent proposé pour le futur appel du module `function` :

```hcl
service_type    = "worker"
concurrency     = 1
min_instances   = 0
max_instances   = 2
timeout_seconds = 300
cpu             = "1"
memory          = "512Mi"
```

Configurer l'ack deadline push à 330 secondes, inférieur au maximum de 600 s et
supérieur au timeout de fonction. La marge tient compte des transactions
Firestore réessayées et de la publication finale ; ce sont des valeurs de départ,
pas le résultat d'un benchmark. Deux instances permettent déjà de tester les
conflits ; une requête par instance limite la pression initiale. La file conserve
les autres messages. Le plafond d'instances ne remplace ni les transactions ni
l'idempotence et n'est pas une preuve d'un plafond strict de charge à tout instant.

Mesurer en dev conflits, latence, débit, backlog et coût avant augmentation.
Le document global des bornes peut créer de la contention. Le timeout total et
les reprises doivent aussi rester compatibles avec le token Discord de 15 minutes.

Ce profil n'est **pas appliqué** : ce changement n'ajoute pas de module Terraform,
topic, abonnement, IAM ou bascule. Les contrats ARCH-03, le raccordement privé
OIDC, les droits runtime Firestore/publication et ce calibrage doivent être revus
séparément avant le déploiement.

## Tests

Depuis `app/` : `npm run typecheck`, `npm run test:coverage`,
`npm run test:integration`, `npm run build:functions`.

Les tests émulateurs exercent DATA-02 et publient les résultats dans Pub/Sub local :
doublons simultanés, événement ancien, pause/reprise, limites de grille, quota,
panne avant confirmation et succès incertain après publication. L'entrée Discord
est produite par le vrai routeur BOT-04 en test ; aucun token réel n'est utilisé.
Les tests HTTP utilisent le vrai Functions Framework. Aucun de ces tests ne
valide les droits IAM/OIDC, le nettoyage TTL cloud ou la charge de production.
