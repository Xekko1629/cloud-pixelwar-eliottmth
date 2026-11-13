# ADR-0009 · Sources des fonctions : construites par la CI, zippées et téléversées par Terraform

- **Statut** : Accepté
- **Date** : 2026-11-12
- **Tickets** : SRV-02 (#30), SRV-02a (#122), SRV-02b (#123). Remplace la section « Artefact de release » de l'[ADR-0008](0008-compute-cloud-run-functions.md) ; le reste de l'ADR-0008 (Cloud Run functions, identités de build, ingress, déclencheurs) reste valable.
- **Références** : Sujet §2.2, §3, §5.5 · C03 §2, §5 · C07 §4

## Contexte

- Le sujet demande que chaque composant serverless soit « deployed with Infrastructure as Code and delivered through CI/CD pipelines with the same GitFlow discipline as the foundation » (§3), avec des releases versionnées qui déclenchent l'apply en dev puis en prd (§2.2).
- Il ne demande ni archive reproductible à l'octet, ni promotion des mêmes octets de dev à prd. L'ADR-0008 l'avait ajouté pour retrouver la garantie « même digest » de l'ADR-0001.
- Mettre en œuvre cette garantie ajoute une chaîne d'empaquetage, un lockfile extrait par fonction avec vérification de la résolution Node.js, un pointeur de release relu par les plans de PR et une publication contrôlée. Cette complexité de maintenance dépasse le périmètre de déploiement retenu ici.
- Une Cloud Run function se déploie depuis un ZIP de sources dans GCS. Le code commun `@pixelwar/shared` est un workspace npm, pas un paquet publié : Cloud Build ne peut pas l'installer. Un regroupement (bundle) reste donc nécessaire.

## Décision

1. **Build dans la CI** : `npm run build:functions` écrit, pour chaque `app/functions/<nom>` :
   - `index.js` : la fonction et `@pixelwar/shared`, regroupés par esbuild ;
   - `package.json` : les paquets npm réellement importés, à leur version exacte du `package-lock.json` du dépôt.

   Le build tourne avant chaque `terraform plan` et `apply` du stack `serverless` (PR, release).
2. **Zip et téléversement par Terraform** (module `function-source`) : `archive_file` zippe le dossier construit, `google_storage_bucket_object` le téléverse dans le bucket privé du bootstrap sous `functions/<nom>/<sha256>.zip`. L'objet et sa génération exacte sont passés au module `function`.
3. **Release** : le tag `v*` applique `serverless` en dev, puis en prd, comme le reste de l'infrastructure. Chaque environnement construit à partir du même commit taggé.

## Options écartées

| Option | Pourquoi elle est écartée |
|---|---|
| Archive construite une fois et promue à l'identique (ADR-0008) | Valide, mais non requise par le périmètre retenu et plus coûteuse à maintenir. |
| Déployer les sources sans bundle | `@pixelwar/shared` n'existe pas dans le registre npm : le build Google échouerait. |
| Tout regrouper dans le bundle, sans dépendance npm | Les bibliothèques Google (`firebase-admin`, `@google-cloud/*`, gRPC) chargent des fichiers à l'exécution (protos, JSON, binaires natifs) : le bundle casserait au runtime. |
| `gcloud functions deploy` dans la CI | Hors de Terraform : le sujet veut un déploiement en IaC. |

## Conséquences

**Ce qu'on y gagne**

- Le déploiement des fonctions suit exactement le même chemin que le reste : plan sur PR, apply sur tag, destroy manuel.
- Peu de code : un build esbuild, un module Terraform d'une trentaine de lignes.
- Le ZIP d'`archive_file` est déterministe : une fonction inchangée garde le même objet et n'est pas redéployée. Un changement de code crée un nouvel objet, donc une nouvelle révision.

**Ce que ça coûte, et ce qu'il faut surveiller**

- Dev et prd construisent chacun leur archive à partir du même commit : le code et les versions directes sont les mêmes, mais rien ne garantit des octets identiques entre les deux.
- Cloud Build installe les dépendances par `npm install` sans lockfile : les versions directes sont épinglées, les dépendances transitives peuvent bouger entre deux déploiements. Les tests restent la protection.
- Le planner lit les objets du bucket de sources (`storage.objectViewer`), pour rafraîchir les objets téléversés pendant les plans de PR.
- Un destroy du stack supprime les objets de sources ; le bucket, versionné, les garde 30 jours.
