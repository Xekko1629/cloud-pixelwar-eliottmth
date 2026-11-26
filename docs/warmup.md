# Warm-up des fonctions

Décision et mesures : [ADR-0017](adr/0017-garder-les-fonctions-chaudes.md).

## Fonctionnement

| Élément | Où | Rôle |
| --- | --- | --- |
| `GET /health` | `@pixelwar/shared/health`, appelé en tête de chaque handler | `204` sans log, sans lecture ni publication, même sans configuration ; `405` pour une autre méthode |
| Jobs `warmup-<fonction>` | `infra/serverless/warmup.tf` | Un appel par minute sur l'URL `run.app` de la fonction, OIDC, sans nouvel essai |
| Compte `function-warmer` | `infra/serverless/warmup.tf` | `roles/run.invoker` sur les fonctions chauffées, rien d'autre |
| Job `gateway-warmup` | `infra/gateway/warmup.tf` | `GET /discord/health` par la gateway chaque minute : garde la gateway et le `discord-proxy` chauds |

Fonctions chauffées : `command-worker`, `draw-worker`, `discord-notifier`,
`admin-worker`, `render-worker`, `web-proxy`, `tile-reader`, `auth-proxy`. Une
fonction non déployée n'a ni job ni droit. `warmup_schedule = null` supprime les
jobs, les droits et le compte.

`/health` n'est pas publié sur la gateway : seule l'identité du warmer peut
l'appeler, directement sur la fonction.

## Dashboards et alertes (OBS)

Chaque appel produit une ligne de **log de requête** Cloud Run, environ 1 440 par
jour et par fonction, mais aucun log applicatif, aucun span et aucune métrique
`pixelwar.function.*` (le handler répond avant la télémétrie).

- Exclure ces requêtes des graphiques de latence, de nombre de requêtes et de taux
  d'erreur construits sur les logs de requête ou sur les métriques Cloud Run
  (`run.googleapis.com/request_count`, `request_latencies`), par exemple avec
  `NOT httpRequest.requestUrl:"/health"` dans un filtre de logs.
- Un `429` sur `/health` du `draw-worker` ou du `render-worker` pendant une rafale
  est attendu : l'instance est occupée. Ne pas en faire une alerte.
- Un `403` sur `/health` signale un droit manquant du compte `function-warmer`.

## Vérifier en dev après un deploy

1. Cloud Scheduler : les 8 jobs `warmup-*` existent, dernière exécution réussie.
2. Logs de requête de chaque fonction : un `GET /health` en `204` par minute.
3. Logs `Starting new instance` : plus de démarrage au moment d'une commande
   (hors deploy et remplacements par la plateforme).
4. Remesurer `/draw`, `/get` et l'affichage de la toile après 30 minutes sans
   commande.
