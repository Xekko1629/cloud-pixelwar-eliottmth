# Accès humains GCP

## Objet et périmètre

`infra/access` gère les attributions humaines des projets et la lecture de
certains secrets dev. Il possède un state distinct et ne fait partie d'aucun
workflow d'apply/destroy. L'opérateur doit disposer des droits de gestion IAM
sur les ressources concernées ; aucune personne particulière n'est requise par
le code.

| Environnement | Backend |
| --- | --- |
| dev | `backends/dev.hcl`, bucket `cloud-pixelwar-eliottmth-dev-tfstate`, préfixe `access` |
| prd | `backends/prd.hcl`, bucket `cloud-pixelwar-eliottmth-prod-tfstate`, préfixe `access` |

## Configuration et droits gérés

Les comptes sont configurés dans les `<env>.tfvars` ; ne pas maintenir une seconde
liste de membres dans ce guide.

- `team_editors` et `instructor_email` : `roles/editor` sur le projet.
- Instructeur : `roles/billing.viewer` sur le compte de facturation, géré par prd.
- `developer_emails` : `roles/secretmanager.secretAccessor` sur
  `discord-bot-token` et `discord-application-id` **en dev seulement**.

Les attributions sont additives : elles ne remplacent pas la policy entière.
La suppression d'un membre de la configuration peut supprimer son attribution
gérée ; lire le plan même si le droit avait été accordé manuellement auparavant.
Les droits hérités ou gérés par un autre mécanisme ne sont pas retirés par ce stack.

Le droit secretAccessor concerne toutes les versions des deux secrets. Il ne
concerne pas les secrets OAuth/admin ni prd. D'autres attributions, notamment
`editor`, peuvent donner des droits supplémentaires : ne pas déduire le moindre
privilège global de la seule lecture ciblée des secrets.

Ce stack ne lit aucune valeur et ne crée pas les conteneurs Secret Manager,
qui relèvent de `infra/iam`. Les identités de CI et leurs droits sont également
gérés par `iam`, pas par ce stack.

## Installation initiale et application

Suivre d'abord le [bootstrap de l'environnement](../../docs/deployment.md) :
projet/facturation, bucket de state, authentification ADC et application de
`infra/iam`. Ce dernier active notamment Cloud Billing, Resource Manager et
Secret Manager.

Depuis `infra/access`, définir `ENV=dev` ou `ENV=prd`. Remplacer le chemin du
plan par un emplacement accessible hors du dépôt : il contient des données
d'identité.

```sh
terraform init -reconfigure -backend-config="backends/$ENV.hcl"
terraform plan -var-file="$ENV.tfvars" -out=/chemin/hors-du-depot/access.tfplan
terraform apply /chemin/hors-du-depot/access.tfplan
```

Lire et approuver le plan avant l'apply. Ne pas supposer un nombre fixe d'ajouts
ni l'absence d'import : cela dépend de l'état réel. Un backend existant ou une
ressource gérée par un autre state exige une vérification préalable.

Pour une application guidée sur backends existants, utiliser
`scripts/apply-manual.sh <env> access` depuis la racine ou `just manual <env> access`.
La commande présente le plan et demande confirmation.

## Vérification et mise à jour

Vérifier la policy projet et les policies des secrets, puis tester avec les
identités concernées les accès autorisés et les refus attendus, sans afficher
de valeurs de secrets dans les logs.

Pour ajouter/retirer un membre : modifier les variables, PR et review, puis
appliquer manuellement la version intégrée. Une correction suit le même parcours ;
ne pas rétablir un ancien membre sans vérifier qu'il est toujours autorisé.

## Suppression et migration

La destruction des workloads ne cible pas ce stack et conserve donc ses
attributions. Le retrait d'accès doit être une modification IAM explicite et
relue, sans retirer le dernier accès d'administration.

Pour migrer un state, identifier les ressources effectivement gérées, conserver
une sauvegarde et vérifier l'état cible avant un import ou un déplacement.
Ne jamais supprimer un ancien objet de state sur la seule hypothèse qu'il est
vide, ni gérer la même attribution depuis deux states.

## Vérification locale

```sh
terraform init -backend=false -input=false -lockfile=readonly
terraform validate
terraform test
```

Les providers simulés vérifient la configuration, pas les droits réels ni leur
propagation. Les résultats d'application et de test d'accès sont conservés dans
les tickets ou rapports, pas comme un inventaire permanent dans ce guide.
