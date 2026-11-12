# ADR-0008 · Compute : Cloud Run functions déployées depuis une archive de sources

- **Statut** : Accepté ; section « Artefact de release » remplacée par [ADR-0009](0009-sources-fonctions-terraform.md)
- **Date** : 2026-11-06
- **Tickets** : ARCH-01 (#26), SRV-01, SRV-02, SRV-04b, SRV-05. Remplace [ADR-0001](0001-compute-cloud-run-typescript.md).
- **Références** : Sujet §3.1, §5.5 · C05 §1-2 · C06 §1-2 · [Build des fonctions](https://cloud.google.com/functions/docs/building) · [Identité de build](https://cloud.google.com/functions/docs/securing/build-custom-sa) · [Ingress Cloud Run](https://cloud.google.com/run/docs/securing/ingress)

## Contexte

- L'application doit être 100 % serverless et suivre le principe de responsabilité unique : une fonction par tâche, chacune avec son propre service account (§3.1).
- L'ADR-0001 avait choisi des **services Cloud Run** avec des images construites par l'équipe. Son argument principal était de promouvoir le même digest d'image en dev et en prd (SRV-02). Il écartait les Cloud Run functions parce que Google reconstruit l'image à chaque déploiement, donc les deux environnements n'exécutent pas le même digest.
- La revue du sujet et les retours de l'évaluateur ont depuis confirmé que **Cloud Run functions** est la cible attendue pour ce projet. Le sujet impose le serverless, pas un mode de packaging particulier ; les functions sont la forme moderne du produit.
- L'objection de l'ADR-0001 reste vraie, mais elle porte sur le mauvais artefact. Ce qui doit être construit une seule fois et promu, c'est **l'archive de sources** ; l'image d'exécution est un détail interne à Google. Une archive identifiée par son SHA-256, copiée sans modification d'un projet à l'autre, garantit que dev et prd exécutent le même code, les mêmes dépendances et le même lockfile.
- Ce choix a un coût assumé : les images produites par Google dans deux projets ne sont pas byte-identiques, et le runtime de base peut évoluer entre deux applies. L'invariant de release devient le SHA-256 de l'archive, pas le digest de l'image.

## Décision

### Compute

Toutes les briques backend sont des **Cloud Run functions HTTP** (`google_cloudfunctions2_function`), sans `event_trigger`.

- Runtime **Node.js 24**, TypeScript compilé. Le handler exporté reçoit `(request, response)` et termine son travail avant de répondre.
- La ressource Terraform est `google_cloudfunctions2_function` (API Cloud Functions v2). C'est la voie qui permet d'épingler la génération GCS, l'identité de build et le dépôt d'images. La variante `gcloud run deploy --function` (API Cloud Run) n'expose pas encore ces contrôles en Terraform.
- Aucun Dockerfile, aucun serveur HTTP applicatif : Google construit et héberge l'image.
- `min_instances = 0` par défaut, `max_instances` plafonné par fonction. Seule exception envisagée : `discord-proxy` à 1 instance en prd, si le cold start menace le délai de 3 s de Discord (BOT-03).
- Une identité d'exécution par fonction, et aucun binding `allUsers`.

### Artefact de release

- La CI construit **une seule fois** une archive ZIP par fonction à partir d'un commit : JavaScript compilé, `package.json` et `package-lock.json`. Cloud Build installe les dépendances verrouillées (`npm ci`) ; aucune plage de versions n'est résolue au déploiement.
- Le nom de l'objet est son SHA-256, par exemple `functions/draw-worker/<sha256>.zip`. La CI calcule le hash, téléverse les octets, puis vérifie le hash des octets stockés.
- Terraform référence le bucket, l'objet, le **SHA-256** et la **génération GCS exacte** (`storage_source.generation`). Il ne référence jamais `latest`.
- La même archive est copiée en dev puis en prd. Le SHA-256 est identique ; la génération GCS peut différer, puisque chaque projet a son bucket. C'est l'archive qui est promue, pas l'image.
- Le bucket `${project_id}-function-sources` est créé par le bootstrap, privé, versionné et conservé hors du state serverless. Il garde 30 jours de générations non courantes, assez pour le rejeu de 15 jours de DATA-02.
- Les images internes sont stockées dans le dépôt Artifact Registry `pixelwar`, créé par le bootstrap. Elles ne sont pas l'artefact de promotion : réappliquer la même archive suffit à reconstruire une image supprimée.

### Identités de build et de déploiement

- Une identité dédiée `function-builder` est créée par le bootstrap. Elle porte seulement :
  - `roles/logging.logWriter` au niveau projet ;
  - `roles/storage.objectViewer` sur le bucket de sources ;
  - `roles/artifactregistry.writer` sur le dépôt.
- Le compte de build par défaut (Compute Engine ou Cloud Build) n'est jamais utilisé. Google exige ces trois rôles pour un build de fonction.
- Le deployer Terraform crée la fonction via l'API Cloud Functions et est autorisé à attacher l'identité d'exécution (`iam.serviceAccounts.actAs`). L'agent de service Cloud Functions porte `roles/cloudfunctions.serviceAgent`.
- Les identités d'exécution et de build sont distinctes : un build compromis ne donne pas les droits Firestore ou Secret Manager du runtime.

### Déclencheurs

- **Proxies** : appelés par API Gateway depuis le réseau public. Ingress `ALLOW_ALL`, mais IAM obligatoire : seul le service account de la gateway reçoit `roles/run.invoker` sur chaque proxy (SRV-04b).
- **Workers** : appelés par **Pub/Sub en push avec un token OIDC** (ADR-0002). Ingress `ALLOW_INTERNAL_ONLY`. La documentation Cloud Run liste explicitement les abonnements Pub/Sub du même projet comme source interne autorisée, même via l'URL `run.app`.
- Chaque worker a une identité d'invocation dédiée, différente de son identité d'exécution, avec `roles/run.invoker` limité à cette fonction.
- Aucun `event_trigger` ni Eventarc : le couple Pub/Sub + push OIDC garde la main sur les retries, la DLQ et le délai d'acquittement (ADR-0002).

### Secrets et observabilité

- Les secrets restent des références Secret Manager avec une version numérique, jamais des valeurs dans Terraform.
- Les rôles d'observabilité (logs, traces, métriques, OTLP) restent attribués au niveau projet à l'identité d'exécution, comme pour les services Cloud Run.

### Périmètre de ce changement

- Ce changement remplace le module de compute et prépare le bootstrap. Il n'instancie encore aucune fonction : le stack `serverless` ne déclare aucun module tant que les handlers et leurs archives n'existent pas.
- L'empaquetage déterministe, l'upload dans chaque bucket et la promotion dev → prd sont livrés par SRV-02. Le contrat d'archive est fixé ici pour que ce ticket ne change plus l'infrastructure.

## Options écartées

| Option | Pourquoi elle est écartée |
|---|---|
| Services Cloud Run avec images construites par l'équipe (ADR-0001) | Techniquement valide et elle garantit un digest identique, mais elle ne correspond plus à la cible Cloud Run functions retenue après les retours de l'évaluateur, et elle demande un Dockerfile, un serveur HTTP et un pipeline d'images à maintenir. |
| Functions reconstruites depuis Git à chaque environnement | Même code source, mais le toolchain et l'image de base peuvent différer entre les deux builds : il n'existe aucun artefact unique à vérifier. C'est exactement le défaut que SRV-02 interdit. |
| Déploiement depuis un chemin local avec `gcloud functions deploy` | Aucune identité d'archive, aucun hash, aucune promotion : le build a lieu pendant le déploiement et le contenu dépend de la machine. |
| Déclencheur Eventarc sur Pub/Sub ou Cloud Storage | Eventarc gère lui-même l'abonnement : pas de DLQ configurable en Terraform, et format CloudEvents inutile ici (ADR-0002). |
| Functions avec une image conteneur fournie par l'équipe | L'API Cloud Functions v2 part d'une archive de sources ; le dépôt d'images n'est qu'une destination interne du build, pas une entrée. |

## Conséquences

**Ce qu'on y gagne**

- La cible correspond au sujet et aux attentes de l'évaluateur, avec un seul langage et un seul paquet partagé.
- Moins de code d'infrastructure : pas de Dockerfile, pas de serveur HTTP, pas de port à écouter.
- Google gère le runtime, les correctifs de sécurité et le scaling à zéro.
- Une release est un fichier vérifiable par son SHA-256, copié à l'identique entre les environnements.
- Le bucket et le registre survivent au destroy du stack serverless : un redéploiement ne dépend pas d'un rebuild local.

**Ce que ça coûte, et ce qu'il faut surveiller**

- Les images dev et prd ne sont pas byte-identiques. À la soutenance, il faut expliquer que l'artefact promu est l'archive, pas l'image ; ne pas prétendre le contraire.
- Un build Cloud Build a lieu pendant `terraform apply`, ce qui allonge l'apply et peut échouer pour une raison externe (quota, build SA, registre). Le job doit exposer les logs de build.
- L'archive doit être autonome : JavaScript compilé, `package.json` et `package-lock.json`. Cloud Build installe les dépendances verrouillées (`npm ci`) sans plage de versions ; aucune dépendance n'est ajoutée à la main au déploiement.
- Le build SA doit garder ses trois rôles, et le deployer doit pouvoir `actAs` les identités d'exécution et de build. Une erreur IAM se manifeste souvent comme un échec de build opaque.
- Le runtime Node.js 24 et l'image de base sont mis à jour par Google : une reconstruction peut changer l'image sans changer l'archive. Les tests de non-régression restent obligatoires.
- Le développement local utilise le Functions Framework, pas le runtime de production : les écarts de comportement (timeouts, concurrence, cold start) doivent être testés en dev.
- Le bucket versionné et le registre ont un coût de stockage ; la politique de rétention doit rester alignée sur le rejeu et les rollbacks.

## En soutenance

- « On déploie des Cloud Run functions : Google construit et héberge l'image, on n'écrit ni Dockerfile ni serveur HTTP. »
- « La release est une archive ZIP identifiée par son SHA-256, construite une fois et copiée telle quelle en dev puis en prd ; Terraform épingle la génération GCS exacte. »
- « Les workers sont en ingress interne et reçoivent Pub/Sub en push OIDC ; les proxies sont appelés par API Gateway avec IAM. Aucun service n'est public. »
