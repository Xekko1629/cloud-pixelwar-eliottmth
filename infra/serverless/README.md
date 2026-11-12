# Stack serverless

## Objet et dépendances

Ce stack déclare les Cloud Run functions et leurs intégrations applicatives.
Le module `function` utilise `google_cloudfunctions2_function` ; Google construit
l'image à partir de sources dans GCS. Le compute est défini par ADR-0008 et le
mécanisme de sources par ADR-0009.

| Ressource/prérequis | Responsable |
| --- | --- |
| APIs, identités de CI, state et conteneurs de secrets | `infra/iam`, manuel |
| Accès humains | `infra/access`, manuel |
| Bucket de sources, registre d'images internes et identité de build | `infra/bootstrap`, CI |
| Réseau et cluster conditionnel | `infra/foundation`, CI |
| Sources, fonctions, IAM runtime/invocation et Gateway déclarés | Ce stack, CI |

Pour une installation vide, suivre le [guide de déploiement](../../docs/deployment.md)
avant le premier init GCS. Chaque environnement utilise ses propres
`<env>.tfvars`, `backends/<env>.hcl` et secrets.

## Sources et fonctions

Le [build applicatif](../../docs/functions.md) écrit les dossiers sous
`app/dist/functions`. Le module `function-source` les zippe et les téléverse sous
`functions/<nom>/<sha256>.zip`, puis fournit bucket, objet, SHA-256 et génération
GCS au [module function](modules/function/README.md).

Les environnements construisent séparément depuis le commit choisi. Il n'y a
pas de promotion par copie d'une archive unique ni de lockfile dans le bundle
livré à Cloud Build. Le lockfile du dépôt verrouille le build CI ; les dépendances
transitives du runtime sont résolues par Google à partir du manifeste généré.

Le bucket de sources est privé, versionné et conservé par le bootstrap. Le
registre reçoit les images internes, pas un artefact fourni par l'équipe.
Vérifier les politiques de rétention et de nettoyage dans `infra/bootstrap` et
les besoins de reprise avant leur modification.

## API Gateway et invocation

`gateway.tf` contient le catalogue de routes et les backends configurés. Une route
n'est publiée que si sa clé de backend est fournie. Sans backend, la Gateway
n'est pas créée et `gateway_url` est nul.

- Proxies : `service_type="proxy"`, ingress `ALLOW_ALL`, mais invocation IAM
  obligatoire. Le module Gateway accorde `roles/run.invoker` à son identité sur
  les seuls proxies routés, pas sur les workers.
- Workers : ingress interne et identité dédiée d'invocation Pub/Sub, distincte
  du runtime. Les abonnements utilisent le push OIDC, sans `event_trigger`.
- Routes API : Firebase par défaut ; routes de connexion et Discord publiques
  à la Gateway, avec validation dans le handler concerné.
- CORS : `cors=true` ajoute un `OPTIONS` public ; le backend doit fournir les
  en-têtes de réponse CORS.

Voir le [contrat du module Gateway](modules/api-gateway/README.md). La
[sonde Discord dev](../../docs/discord-hello.md) est activée par
`enable_discord_hello`, n'est jamais instanciée en prd et publie seulement le
callback `/discord/interactions` lorsqu'elle est activée.

## Secrets

Les conteneurs et valeurs vivent dans Secret Manager ; ce stack donne à chaque
runtime `secretAccessor` sur les seuls secrets référencés dans le module
`function`. Utiliser une version numérique activée, jamais une valeur de secret
dans Terraform. Voir [alimentation et rotation](../iam/SECRETS.md).

## Vérification locale et plan

Depuis la racine du dépôt, construire les sources avant un plan qui les archive :

```sh
cd app
npm ci
npm run build:functions
cd ../infra/serverless
terraform init -backend=false
terraform validate
terraform test
```

Les tests racine simulent les providers. Les tests de chaque module sont lancés
séparément par la CI ; Terraform ne les découvre pas automatiquement depuis la
racine. Pour un plan distant, réinitialiser ensuite le backend sélectionné :

```sh
terraform init -reconfigure -backend-config=backends/dev.hcl
terraform plan -var-file=dev.tfvars
```

Remplacer ensemble les références dev par prd pour viser prd. Un plan distant
lit GCP et le state : ce n'est pas un test sans accès cloud.

## Déploiement, vérification et retrait

Utiliser [Deploy](../../docs/deployment.md#6-déployer-dev-par-la-ci), pas un
déploiement `gcloud functions deploy` parallèle à Terraform. Un lancement manuel
vise dev ; un tag `v*` déclenche aussi prd. Lire les plans et valider la portée
avant le déclenchement.

Après application, vérifier les outputs, URLs, génération de source, identité
runtime et policies d'invocation. Tester un appel autorisé et un refus anonyme,
puis l'intégration concernée : callback Discord, JWT Firebase ou push Pub/Sub.
Les tests simulés ne prouvent ni ces permissions réelles ni le délai de réponse.

`Destroy` supprime les ressources de ce stack, mais conserve `iam`, `access` et
`bootstrap`. Les archives gérées dans ce state sont supprimées comme objets
courants ; les versions/rétentions du bucket peuvent conserver des données et
des coûts. Consulter [suppression et reprise](../../docs/deployment.md#suppression)
avant tout nettoyage complet ; ne pas supprimer des generations ou states sans
examiner leurs usages et sauvegardes.
