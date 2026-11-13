# Module api-gateway

Crée le point d'entrée HTTP public des proxies applicatifs Cloud Run functions
([ADR-0008](../../../../docs/adr/0008-compute-cloud-run-functions.md)) :

- une API et sa gateway régionale, joignable en HTTPS sur l'URL `*.gateway.dev` par défaut ;
- une configuration d'API générée à partir de [`openapi.yaml.tftpl`](openapi.yaml.tftpl) (OpenAPI 2.0, seule version acceptée par API Gateway) ;
- un service account dédié `<api_id>-gateway`, avec lequel la gateway appelle les proxies ;
- `roles/run.invoker` pour ce service account, **sur le service Cloud Run sous-jacent de chaque proxy routé uniquement**, jamais au niveau du projet ni sur un worker (SRV-04b) ;
- l'activation du service géré créé pour l'API (`<api>-<hash>.apigateway.<projet>.cloud.goog`). Son nom est connu dès la création de l'API, mais sa configuration de service n'existe qu'après la première configuration d'API : l'activation est donc ordonnée après celle-ci, puis la gateway après l'activation. Il ne peut pas être déclaré dans `infra/iam/apis.tf` comme les autres APIs.

Les ressources API Gateway n'existent que dans le provider `google-beta`. Les APIs `apigateway`, `servicemanagement` et `servicecontrol` sont activées par `infra/iam`.

## Utilisation

Le catalogue des routes vit dans [`infra/gateway/routes.tf`](../../../gateway/routes.tf).
Le stack appelant lit les proxies dans le contrat d'outputs appliqué de
`serverless`, pas dans une référence directe aux ressources du module
[`function`](../function/README.md) du même state (ADR-0010) :

```hcl
module "api_gateway" {
  source = "../serverless/modules/api-gateway"

  project_id = var.project_id
  region     = var.region

  routes = [
    { path = "/hello", method = "get", backend = "hello", operation_id = "hello", summary = "Hello" },
  ]
  backends = {
    hello = { function_name = "hello-proxy", uri = "https://<URI-exportée>", service_type = "proxy" }
  }
}
```

- Une route dont la clé `backend` est absente de `backends` n'est pas publiée. Au moins une route doit l'être, sinon le plan échoue sur une précondition.
- Un backend `service_type = "worker"` est refusé : les workers ne sont appelés que par Pub/Sub (ADR-0002).
- `auth` vaut `firebase` par défaut : une route publique doit l'écrire explicitement (`auth = "none"`). Une route sous `/api/` (`protected_path_prefixes`) sans `firebase` est refusée au plan.
- `cors = true` ajoute la route `OPTIONS` du même chemin, sans `security`, vers le même backend. Une route `options` déclarée à la main est refusée.

## Fonctionnement

- **Routage** : `x-google-backend.address` est l'`uri` exportée par le module `function`, avec `path_translation: APPEND_PATH_TO_ADDRESS`. La fonction reçoit le chemin complet (`/discord/interactions`) et la query string d'origine. Le Functions Framework envoie tous les chemins au même handler, qui peut donc vérifier `req.path` et `req.method`. Le corps est transmis tel quel, ce qui permet au `discord-proxy` de vérifier la signature Ed25519 sur le corps brut.
- **Authentification vers la fonction** : la gateway signe un ID token Google au nom de son service account, avec l'URL de la fonction comme audience (`jwt_audience`, fixée explicitement). Cloud Run le vérifie avant d'exécuter le code. La gateway remplace donc l'en-tête `Authorization` d'origine : pour les routes protégées (SRV-04c), les claims de l'utilisateur arrivent dans `X-Apigateway-Api-Userinfo`.
- **Délais** : 15 s par défaut, 3 s pour les interactions Discord (le délai de réponse imposé par Discord).
- **Configuration immuable** : une configuration d'API ne peut pas être modifiée. Elle porte un ID généré à partir de `api_config_id_prefix`, et `create_before_destroy` crée la nouvelle configuration, bascule la gateway dessus, puis supprime l'ancienne. Avec un ID fixe, chaque changement de spécification ferait échouer l'apply.

## Authentification des routes

| Route | À la gateway | Vérifié ensuite par |
| --- | --- | --- |
| `POST /discord/interactions` | publique | `discord-proxy` : signature Ed25519 sur le corps brut, avant tout traitement (Sujet §3.2) |
| `GET /auth/login`, `POST /auth/exchange` | publiques (l'utilisateur n'a pas encore de token) | `auth-proxy` : `state` signé, échange du code OAuth2 (ADR-0005) |
| `POST /api/*` | **ID token Firebase obligatoire** | le proxy lit l'identité dans `X-Apigateway-Api-Userinfo` |
| `OPTIONS` des routes `cors = true` | publiques | le backend renvoie les en-têtes CORS |
| `GET /hello` (temporaire, #39) | ID token Firebase obligatoire | — |

- La définition `firebase` n'accepte que les ID tokens émis pour ce projet : émetteur `https://securetoken.google.com/<project_id>`, audience `<project_id>`, signature vérifiée avec les clés publiques de `securetoken@system.gserviceaccount.com`, expiration contrôlée. Un token de dev est donc refusé en prd. Sans token, ou avec un token invalide, la gateway répond **401 sans appeler la fonction** : la requête ne coûte aucune invocation.
- La gateway remplace `Authorization` par son propre token pour appeler la fonction. L'identité de l'utilisateur arrive dans `X-Apigateway-Api-Userinfo` (claims JSON en base64url) : le proxy prend l'`uid` (= id Discord) à cet endroit, jamais dans le corps de la requête.
- Les routes `OPTIONS` sont nécessaires : le navigateur envoie le preflight CORS
  sans `Authorization`. Sans route publique correspondante, il recevrait un 401.
  Le backend doit répondre au preflight (`Access-Control-Allow-Origin` limité à
  l'origine du frontend, `Access-Control-Allow-Headers: Authorization, Content-Type`)
  et ajouter les en-têtes à ses réponses ; générer la route ne configure pas ces
  réponses à sa place.

### Limitation de débit à la gateway : étude

Sur GCP, API Gateway ne limite le débit que par **quotas de consommateur** (`x-google-management` + `x-google-quota`), et un consommateur est identifié par une **clé d'API**. Conclusion : **pas de quota à la gateway**, pour ces raisons :

- La clé d'API serait embarquée dans le bundle du frontend, donc publique. Le quota s'appliquerait à cette clé, partagée par tous les utilisateurs (et par un attaquant qui la copie) : c'est un plafond global, pas une limite par utilisateur. Un seul abus bloquerait tout le monde.
- Discord ne peut pas envoyer d'en-tête personnalisé ; la clé devrait figurer en clair dans l'URL d'interactions, sans apporter d'identification réelle.
- Le sujet (§3.3) demande une limite **par utilisateur**, 20 pixels/minute par défaut, modifiable par `/admin ratelimit`. Seul le worker la connaît : elle est appliquée dans le `draw-worker`, en transaction Firestore (DATA-03, [docs/rate-limits.md](../../../../docs/rate-limits.md)), pour Discord comme pour le web, puisque l'uid est le même.

La protection contre les rafales repose donc sur :

1. la gateway, qui rejette sans invocation tout appel `/api/*` sans ID token valide ;
2. le `max_instances` de chaque fonction proxy, qui plafonne la concurrence et le coût ;
3. Pub/Sub, qui absorbe les pics entre les proxies et les workers ;
4. la limite par utilisateur du worker, avec rejet métier publié (ADR-0002).

## Vérification sur un environnement déployé

Prérequis de l'exemple : un backend HTTP de test est configuré et déployé sur la
route **GET `/hello` avec authentification Firebase**, et un ID token du bon
projet est disponible. Cet exemple n'est pas la slash command Discord `/hello`.
Pour la sonde Discord sur `/discord/interactions`, suivre
[son runbook](../../../../docs/discord-hello.md).

```sh
GATEWAY=$(terraform -chdir=infra/gateway output -raw gateway_url)
: "${FUNCTION_URL:?Renseigner l'URI du backend de test}"
: "${ID_TOKEN:?Fournir un ID token Firebase du projet sans l'afficher}"

# Sans token : 401 renvoyé par la gateway, la fonction n'est pas invoquée (aucun log côté fonction).
curl -i "$GATEWAY/hello"

# Avec token : la fonction répond et logge le chemin, la méthode, la query reçus
# et l'uid lu dans X-Apigateway-Api-Userinfo.
curl -i -H "Authorization: Bearer $ID_TOKEN" "$GATEWAY/hello?probe=1"

# Appel anonyme direct au backend : refusé par Cloud Run (403), le code ne s'exécute pas.
curl -i "$FUNCTION_URL/hello"

# Méthode non déclarée dans la spec : rejetée par la gateway, sans atteindre la fonction.
curl -i -X DELETE -H "Authorization: Bearer $ID_TOKEN" "$GATEWAY/hello"

# Preflight d'une route navigateur : atteint le backend sans token.
curl -i -X OPTIONS -H "Origin: https://<frontend>" -H "Access-Control-Request-Method: POST" "$GATEWAY/api/pixels"
```

Vérifier aussi l'absence de binding public sur les proxies :

```sh
gcloud run services get-iam-policy NOM_DU_BACKEND --project=ID_DU_PROJET --region=europe-west1
```

Adapter les noms et vérifier l'ensemble des membres autorisés, y compris les
droits hérités ; aucun `allUsers` ou `allAuthenticatedUsers` ne doit permettre
une invocation anonyme. Pour installation, mise à jour et retrait de la Gateway,
utiliser le [runbook Gateway](../../../gateway/README.md).

## Tests

```sh
terraform init -backend=false
terraform test
```

Les tests utilisent des providers simulés : aucune ressource GCP n'est créée. Ils vérifient le rendu de la spécification (chemin, audience, délai), le filtrage des routes, l'ID de configuration généré, la portée des droits `run.invoker`, le refus d'un worker comme backend, la validation Firebase sur `/api/*`, l'absence de `security` sur Discord, `/auth/*` et les preflights, et le refus d'une route `/api/*` publique.
