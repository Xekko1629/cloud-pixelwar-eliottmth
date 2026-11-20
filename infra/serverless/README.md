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
| Sources, fonctions et IAM runtime/invocation des workers | Ce stack, CI |
| Gateway, catalogue HTTP et invocation des proxies | `infra/gateway`, CI après ce stack |

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

`gateway-backends.tf` exporte `gateway_contract`, avec les noms, URI et types des
proxies réellement instanciés. Le catalogue de routes et la Gateway sont gérés
dans le [stack Gateway](../gateway/README.md), avec un state indépendant pour
isoler son `create_before_destroy` de celui des fonctions (ADR-0010). Une route
n'est publiée que si sa clé de backend est exportée. Sans backend, le stack
Gateway ne crée pas de Gateway et son output `gateway_url` est nul.

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

### Dispositif Discord de diagnostic (dev)

`discord-proxy.tf` et `discord-command.tf` préparent le proxy, le topic, le worker
privé de vérification, le push OIDC, les retries et la DLQ avec son abonnement
d'inspection. Les deux abonnements conservent les messages non acquittés 7 jours,
sans conserver les acquittés et sans expiration pour inactivité.

- `enable_discord_pipeline=true` crée le dispositif en dev seulement.
- `enable_discord_delivery=true` active ensuite le push et ses droits, après
  l'initialisation IAM ciblée du deployer et du planner.
- `use_discord_proxy=true` choisit séparément le proxy comme backend exporté.
- `dev.tfvars` active la création, sans livraison, et **garde le routage sur hello**.
- Ces trois flags n'ont aucun effet en prd ; leurs valeurs par défaut sont `false`.

Cette configuration n'est pas appliquée. `infra/iam/discord-verify.tf` prépare
les droits CI sur le seul nouvel invoker : opt-in dev après création du compte,
apply IAM autorisé séparément avant activation de la livraison. Voir
[les phases et prérequis](../../docs/discord-proxy.md).
Le nom d'abonnement est partagé via une valeur locale pour éviter un cycle
entre la fonction et l'abonnement.

Revenir vers hello change seulement `use_discord_proxy`, pas les activations du
pipeline et de la livraison. Les désactiver planifierait des suppressions. Le CLI
ciblé `--draw` est prêt localement, son exécution réelle, l'alerte DLQ et la validation dev
restent à faire. Le worker de
diagnostic n'est pas le futur worker métier.

## Firestore

`firestore.tf` crée la base `(default)` en mode Native dans la région du stack,
ses index composites (flux de deltas par région et global, tuiles d'une région),
les exemptions d'indexation des champs binaires et maps (`colors`, `pixels`) et
les politiques TTL sur `expire_at` des collections `deltas` et
`processed_events`. Les documents `users/{uid}` n'expirent pas : ils portent le
quota et le dernier rejet.

- Aucune règle de sécurité : aucun client ne parle à Firestore (ADR-0013).
  Chaque fonction reçoit sur son compte d'exécution `roles/datastore.user`
  (écriture) ou `roles/datastore.viewer` (lecture), jamais un rôle projet large.
- `destroy` supprime la base (`deletion_policy = "DELETE"`). Avec
  `firestore_deletion_protection = true`, GCP refuse la suppression et le destroy
  échoue au lieu de perdre la grille.
- Après une suppression, l'ID `(default)` n'est réutilisable qu'après environ
  5 minutes : attendre avant de réappliquer le stack.
- Le TTL supprime les documents expirés en général sous 24 h ; les requêtes
  filtrent donc toujours sur `created_at` (ADR-0003).

## Cloud Storage

`storage.tf` crée deux buckets privés, `<projet>-snapshots` et
`<projet>-overview`, avec accès uniforme (IAM seulement, pas d'ACL) et
`public_access_prevention = "enforced"`. Ils ne contiennent que des images
dérivées de Firestore : `force_destroy = true` permet au workflow `Destroy`
de les supprimer avec leurs objets, en dev comme en prd. Ils ne remplacent pas
le bucket de sources persistant d'`infra/bootstrap`.

- `snapshots` : PNG de `/snapshot` (BOT-07a), partagés par URL signée (BOT-07b).
  Une règle lifecycle supprime les objets après `snapshot_retention_days`
  (7 jours par défaut, la durée maximale d'une URL signée V4).
- `overview` : pyramide de la vue éloignée (DATA-05c). Aucune expiration, les
  images actives sont réécrites par l'`overview-worker`.
- Une notification `OBJECT_FINALIZE` du bucket `snapshots` publie dans le topic
  `snapshot-ready`, au format `JSON_API_V1`, sans enveloppe métier
  ([catalogue](../../docs/events.md), section 5). L'agent de service Cloud
  Storage reçoit `roles/pubsub.publisher` sur ce seul topic.

Aucun abonnement n'écoute encore `snapshot-ready` : l'abonnement push OIDC vers
le `snapshot-notifier` est créé avec lui (SRV-05, BOT-07b). D'ici là, une
notification publiée n'est conservée par aucun abonnement. Aucune identité ne
reçoit encore de droit sur les buckets : chaque worker recevra son rôle objet sur
le bucket qu'il utilise, pas un rôle projet.

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

Pour l'essai Discord, l'accord de préparation ne vaut pas accord de déploiement.
Le workflow actuel ne s'arrête pas entre plan/apply et bascule Gateway : ne pas
le lancer avant validation du mécanisme de revues séparées décrit dans le guide
proxy. Aucun workflow de déploiement n'est modifié pour cet essai.

Après application, vérifier les outputs, URLs, génération de source, identité
runtime et policies d'invocation. Tester un appel autorisé et un refus anonyme,
puis l'intégration concernée : callback Discord, JWT Firebase ou push Pub/Sub.
Les tests simulés ne prouvent ni ces permissions réelles ni le délai de réponse.

`Destroy` supprime d'abord Gateway puis les ressources de ce stack, mais conserve `iam`, `access` et
`bootstrap`. Les archives gérées dans ce state sont supprimées comme objets
courants ; les versions/rétentions du bucket peuvent conserver des données et
des coûts. Consulter [suppression et reprise](../../docs/deployment.md#suppression)
avant tout nettoyage complet ; ne pas supprimer des generations ou states sans
examiner leurs usages et sauvegardes.
