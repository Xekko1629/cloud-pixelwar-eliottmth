# Module api-gateway

Crée l'unique point d'entrée public de l'application (Sujet §3.1, C05 §3) devant les Cloud Run functions proxies ([ADR-0008](../../../../docs/adr/0008-compute-cloud-run-functions.md)) :

- une API et sa gateway régionale, joignable en HTTPS sur l'URL `*.gateway.dev` par défaut ;
- une configuration d'API générée à partir de [`openapi.yaml.tftpl`](openapi.yaml.tftpl) (OpenAPI 2.0, seule version acceptée par API Gateway) ;
- un service account dédié `<api_id>-gateway`, avec lequel la gateway appelle les proxies ;
- `roles/run.invoker` pour ce service account, **sur le service Cloud Run sous-jacent de chaque proxy routé uniquement**, jamais au niveau du projet ni sur un worker (SRV-04b) ;
- l'activation du service géré créé pour l'API (`<api>-<hash>.apigateway.<projet>.cloud.goog`). Il est créé dynamiquement avec l'API, il ne peut donc pas être déclaré dans `infra/iam/apis.tf` comme les autres APIs.

Les ressources API Gateway n'existent que dans le provider `google-beta`. Les APIs `apigateway`, `servicemanagement` et `servicecontrol` sont activées par `infra/iam`.

## Utilisation

Le catalogue des routes et la liste des proxies déployés vivent dans le stack appelant ([`gateway.tf`](../../gateway.tf)). Les backends reprennent les outputs du module [`function`](../function/README.md) :

```hcl
module "api_gateway" {
  source = "./modules/api-gateway"

  project_id = var.project_id
  region     = var.region

  routes = [
    { path = "/hello", method = "get", backend = "hello", operation_id = "hello", summary = "Hello" },
  ]
  backends = {
    hello = { function_name = module.hello.name, uri = module.hello.uri, service_type = module.hello.service_type }
  }
}
```

- Une route dont la clé `backend` est absente de `backends` n'est pas publiée. Au moins une route doit l'être, sinon le plan échoue sur une précondition.
- Un backend `service_type = "worker"` est refusé : les workers ne sont appelés que par Pub/Sub (ADR-0002).

## Fonctionnement

- **Routage** : `x-google-backend.address` est l'`uri` exportée par le module `function`, avec `path_translation: APPEND_PATH_TO_ADDRESS`. La fonction reçoit le chemin complet (`/discord/interactions`) et la query string d'origine. Le Functions Framework envoie tous les chemins au même handler, qui peut donc vérifier `req.path` et `req.method`. Le corps est transmis tel quel, ce qui permet au `discord-proxy` de vérifier la signature Ed25519 sur le corps brut.
- **Authentification vers la fonction** : la gateway signe un ID token Google au nom de son service account, avec l'URL de la fonction comme audience (`jwt_audience`, fixée explicitement). Cloud Run le vérifie avant d'exécuter le code. La gateway remplace donc l'en-tête `Authorization` d'origine : pour les routes protégées (SRV-04c), les claims de l'utilisateur arrivent dans `X-Apigateway-Api-Userinfo`.
- **Délais** : 15 s par défaut, 3 s pour les interactions Discord (le délai de réponse imposé par Discord).
- **Configuration immuable** : une configuration d'API ne peut pas être modifiée. Elle porte un ID généré à partir de `api_config_id_prefix`, et `create_before_destroy` crée la nouvelle configuration, bascule la gateway dessus, puis supprime l'ancienne. Avec un ID fixe, chaque changement de spécification ferait échouer l'apply.

## Vérification sur un environnement déployé

À faire une fois la fonction hello (#39) branchée dans `local.gateway_backends` :

```sh
GATEWAY=$(terraform output -raw gateway_url)
FUNCTION_URL=<uri de la fonction hello>

# Via la gateway : la fonction répond et logge le chemin, la méthode et la query reçus.
curl -i "$GATEWAY/hello?probe=1"

# Appel anonyme direct au backend : refusé par Cloud Run (403), le code ne s'exécute pas.
curl -i "$FUNCTION_URL/hello"

# Méthode non déclarée dans la spec : rejetée par la gateway, sans atteindre la fonction.
curl -i -X DELETE "$GATEWAY/hello"
```

Vérifier aussi l'absence de binding public sur les proxies :

```sh
gcloud run services get-iam-policy hello --region europe-west1   # seul pixelwar-gateway a run.invoker
```

## Hors de ce module (pour l'instant)

- Validation du JWT Firebase sur `/api/*`, routes `OPTIONS` pour le preflight CORS, limitation de débit : SRV-04c (#34).

## Tests

```sh
terraform init -backend=false
terraform test
```

Les tests utilisent des providers simulés : aucune ressource GCP n'est créée. Ils vérifient le rendu de la spécification (chemin, audience, délai), le filtrage des routes, l'ID de configuration généré, la portée des droits `run.invoker` et le refus d'un worker comme backend.
