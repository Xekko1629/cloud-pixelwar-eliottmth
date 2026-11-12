# Fonctions : structure, build et déploiement — SRV-02

Chaque proxy ou worker est une **Cloud Run function HTTP** ([ADR-0008](adr/0008-compute-cloud-run-functions.md)).
La CI la construit, Terraform la zippe, la téléverse et la déploie ([ADR-0009](adr/0009-sources-fonctions-terraform.md)).

```text
app/functions/<nom>/src   ──npm run build:functions──▶   app/dist/functions/<nom>/{index.js, package.json}
                          ──Terraform (function-source)─▶  gs://<projet>-function-sources/functions/<nom>/<sha256>.zip
                          ──Terraform (function)────────▶  Cloud Build installe les dépendances, Google déploie la fonction
```

## Ajouter une fonction

```text
app/functions/<nom>/
├── package.json
└── src/
    ├── index.ts        # exporte le handler HTTP
    └── *.test.ts       # tests, jamais embarqués
```

- `<nom>` suit la règle du module `function` : 6 à 30 caractères, minuscules, chiffres et
  tirets (`hello-proxy`, `draw-worker`). C'est aussi le nom de la fonction et de son service
  account.
- `src/index.ts` exporte un handler `(req, res)` compatible Functions Framework, qui termine
  son travail avant de répondre. Pas de Dockerfile, pas de serveur HTTP.
- `package.json` :

  ```json
  {
    "name": "@pixelwar/function-<nom>",
    "private": true,
    "type": "module",
    "pixelwar": { "entryPoint": "handleHello" },
    "dependencies": {
      "@google-cloud/functions-framework": "5.0.5",
      "@pixelwar/shared": "*"
    }
  }
  ```

  `pixelwar.entryPoint` est le nom exporté par `src/index.ts`, à reporter dans `entry_point`
  du module `function`. Toute dépendance npm importée par la fonction est déclarée dans
  **ses** `dependencies`, et celles importées par `shared` dans celles de `shared` : une
  dépendance de dev remontée à la racine du workspace est refusée.
  `@google-cloud/functions-framework` est obligatoire.

Puis `npm install` depuis `app/` pour mettre à jour `package-lock.json`.

## Construire

```sh
cd app
npm run build:functions               # toutes les fonctions
npm run build:functions -- hello-proxy
```

Pour chaque fonction, `app/dist/functions/<nom>/` contient seulement :

| Fichier | Contenu |
| --- | --- |
| `index.js` | La fonction et `@pixelwar/shared`, regroupés par esbuild en un module ESM. Non minifié, pour des traces d'erreur lisibles dans Cloud Logging. |
| `package.json` | Les paquets npm réellement importés, à leur version exacte du lockfile du dépôt (celle de `shared/node_modules` quand `shared` a sa propre version), avec `main: index.js`. |

Rien d'autre : ni `.env`, ni tests, ni fichiers locaux. Seul ce qui est importé depuis
`src/index.ts` entre dans le bundle, et un test atteignable depuis le handler fait échouer
le build.

**Pourquoi un bundle ?** `@pixelwar/shared` est un workspace npm, pas un paquet publié : Cloud
Build ne saurait pas l'installer. Les paquets npm, eux, restent installés par Cloud Build tels
que publiés, car les bibliothèques Google chargent des fichiers à l'exécution (protos, JSON,
binaires natifs).

## Déployer avec Terraform

Dans `infra/serverless`, une fonction est deux appels de module (exemple complet dans
[`functions.tf`](../infra/serverless/functions.tf)) :

```hcl
module "hello_source" {
  source     = "./modules/function-source"
  name       = "hello-proxy"
  source_dir = "${path.root}/../../app/dist/functions/hello-proxy"
  bucket     = local.function_build.sources_bucket
}

module "hello" {
  source         = "./modules/function"
  # ...
  source_archive = module.hello_source.source_archive
}
```

- `function-source` zippe le dossier (`archive_file`, déterministe) et le téléverse sous
  `functions/<nom>/<sha256>.zip` dans le bucket privé du bootstrap. Une fonction inchangée
  garde le même objet et n'est pas redéployée ; un changement de code crée un nouvel objet,
  donc une nouvelle révision.
- `function` déploie depuis cet objet et sa génération exacte.

La CI construit les fonctions avant chaque plan et apply du stack `serverless`
(`_plan.yml`, `_apply.yml`), et la CI applicative vérifie que toutes se construisent. Un tag
`v*` applique dev puis prd, comme le reste de l'infrastructure. En local, lancer
`npm run build:functions` avant `just plan dev serverless`.
