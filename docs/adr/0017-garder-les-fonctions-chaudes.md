# ADR-0017 · Garder les fonctions chaudes par un warmer

- **Statut** : Proposé
- **Date** : 2026-11-26
- **Tickets** : SRV-05 (#35), BOT-06 (#53), DRAW-02 (#46). Complète [ADR-0008](0008-compute-cloud-run-functions.md) et [ADR-0016](0016-proxy-discord-en-go.md).
- **Références** : [Tarifs Cloud Run](https://cloud.google.com/run/pricing) · [Restriction de l'ingress Cloud Run](https://docs.cloud.google.com/run/docs/securing/ingress) · `infra/gateway/warmup.tf` · `docs/deploy-draw-path.md`

## Contexte

- Toutes les fonctions sont à `min_instances = 0` et en facturation à la requête
  (pas d'annotation `cpu-throttling: false`), avec le boost CPU au démarrage déjà
  actif. Une instance sans trafic pendant environ 15 minutes est arrêtée ; la
  commande suivante paie un démarrage à froid Node de 2 à 3 s par fonction de la
  chaîne.
- Mesures en dev du 21 au 26/11/2026 (logs Cloud Run : durée de la première
  requête d'une instance neuve moins la médiane à chaud) :

  | Fonction | Démarrages | 1ʳᵉ requête | À chaud | Gain |
  |---|---|---|---|---|
  | `command-worker` | 15 | 2,32 s | 0,14 s | ≈ 2,2 s |
  | `draw-worker` | 23 | 3,42 s | 0,20 s | ≈ 3,2 s |
  | `discord-notifier` | 19 | 2,06 s | 0,10 s | ≈ 2,0 s |
  | `admin-worker` | 8 | 3,51 s | 0,63 s | ≈ 2,9 s |
  | `render-worker` | 2 | 4,20 s | 1,68 s | ≈ 2,5 s (1 seul cas) |
  | `tile-reader` | 9 | 3,24 s | 0,12 s | ≈ 3,1 s |
  | `web-proxy` | 8 | 3,09 s | 0,16 s | ≈ 2,9 s |
  | `auth-proxy` | 8 | 1,41 s | 0,07 s | ≈ 1,3 s |
  | `frontend` (nginx) | 14 | 0,13 s | 0,00 s | négligeable |

- Par commande, tout étant froid : `/draw` ≈ 7,4 s de plus (`command-worker`,
  `draw-worker`, `notifier`), `/admin` ≈ 5,1 s, `/get` ≈ 4,7 s. La trace d'un
  `/get` du 26/11 à 19:40:29 UTC donne 11,7 s au total, dont 6 s de démarrages.
- Le warmer de la gateway (`gateway-warmup`, toutes les 5 minutes sur
  `/discord/health`) garde le `discord-proxy` chaud : 3 démarrages en 4 jours
  (23 au 26/11), aucun sur une requête d'utilisateur. Deux remplacements ont été
  préparés par la plateforme avant l'arrêt de l'ancienne instance ; le troisième
  a été absorbé par l'appel du warmer (0,51 s).

## Décision

- Un job Cloud Scheduler **par fonction** appelle `GET /health` toutes les
  minutes (`warmup_schedule`, `null` désactive), sur l'URL `run.app` de la
  fonction, avec un jeton OIDC dont l'audience est cette URL. Pas de nouvel essai,
  délai de 15 s.
- Fonctions concernées : `command-worker`, `draw-worker`, `discord-notifier`,
  `admin-worker`, `render-worker`, `web-proxy`, `tile-reader`, `auth-proxy`. Le
  `discord-proxy` reste chauffé par la gateway, dont le job passe aussi à chaque
  minute. Ni le `frontend` (gain négligeable) ni `discord-hello` (à supprimer).
- Identité dédiée `function-warmer` : son seul droit est `roles/run.invoker` sur
  le service Cloud Run de chacune de ces fonctions. Elle ne lit et n'écrit rien.
- Chaque fonction répond `204` à `GET /health` **avant toute vérification de
  configuration**, sans log applicatif, sans lecture ni publication
  (`@pixelwar/shared/health`). Une autre méthode reçoit `405`.
- Les workers gardent l'ingress `internal` : Cloud Scheduler du même projet est
  une source autorisée sur l'URL `run.app`.

## Options écartées

- **`min_instances = 1`** : instance garantie, mais facturée en continu au tarif
  de repos (≈ 0,0000025 $ par vCPU-seconde et par Gio-seconde), soit ≈ 9,7 $ par
  mois pour 1 vCPU / 512 Mio et ≈ 13 $ pour 1 vCPU / 1 Gio, par fonction et par
  environnement. Elle n'empêche pas non plus le remplacement d'une instance par la
  plateforme. Reste possible pour les quelques heures d'une démonstration.
- **Warmer toutes les 5 minutes** : le trou possible après un remplacement non
  préparé va jusqu'à 5 minutes ; à chaque minute, il tombe à 1 minute pour un
  coût toujours nul.
- **Relancer une instance à l'arrêt (`SIGTERM`)** : supprime presque le trou,
  mais chaque fonction doit connaître sa propre URL et s'invoquer elle-même, et le
  signal arrive aussi lors d'un deploy ou d'une réduction d'instances.
- **Une seule fonction `warmer` qui appelle les autres** : un seul job gratuit,
  mais une fonction de plus à maintenir et un point de panne unique.
- **Réécrire les workers en Go** : démarrage ≈ 0,4 s mesuré sur le proxy, mais
  réécriture lourde (le rendu PNG de DATA-05b pour le `render-worker`). Reste une
  option si le warmer ne suffit pas.

## Conséquences

- Coût : 9 jobs Scheduler par environnement dont 3 gratuits par compte de
  facturation, soit ≈ 0,60 $ par mois. Les ≈ 43 200 appels mensuels par fonction,
  facturés 100 ms chacun, restent dans le palier gratuit de Cloud Run.
- Les instances arrêtées par la plateforme restent possibles : au pire une minute
  sans instance prête, puis un démarrage à froid normal.
- `draw-worker` et `render-worker` traitent un message à la fois : pendant une
  rafale, l'appel du warmer peut recevoir un `429`. Il n'est pas réessayé, et
  l'instance est de toute façon occupée.
- Chaque appel laisse une ligne de log de requête Cloud Run (≈ 43 200 par mois et
  par fonction) : les dashboards et alertes doivent exclure `/health`
  ([docs/warmup.md](../warmup.md)).
- À valider en dev après deploy : `204` dans les logs de chaque fonction, plus de
  démarrage à froid sur les commandes, `/get` et `/draw` remesurés.
