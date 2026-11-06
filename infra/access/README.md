# Accès humains (ACC-01)

Stack séparé des workloads (sujet §1.3, §2.1, C03 §9) : un destroy de
`foundation`, `runners` ou `serverless` ne retire l'accès à personne. Un state
par environnement, **appliqué uniquement à la main par Xekko**, jamais par la CI :

| Env | Backend |
| --- | --- |
| dev | bucket `cloud-pixelwar-eliottmth-dev-tfstate`, préfixe `access` |
| prd | bucket `cloud-pixelwar-eliottmth-prod-tfstate`, préfixe `access` |

Aucune identité de CI ne peut modifier l'IAM d'un projet : un compte de service
capable de donner `roles/editor` pourrait se le donner à lui-même, puis agir
comme le deployer. La CI se contente de `fmt`, `validate` et `test`.

## Équipe et instructeur

| Principal | Rôle | Où |
| --- | --- | --- |
| Membres de `team_editors` (Benjamin, IncognitoDev) | `roles/editor` | dev et prd |
| Instructeur `jeremie@jjaouen.com` | `roles/editor` | dev et prd |
| Instructeur | `roles/billing.viewer` | compte de facturation `0111A1-F02A73-B2E667`, géré par prd seulement (commun aux deux projets) |

Attributions **additives** (`google_project_iam_member`,
`google_billing_account_iam_member`) : la policy des projets n'est jamais
remplacée. Le `roles/owner` d'Eliott reste volontairement hors Terraform, pour
qu'une erreur ici ne puisse pas retirer le dernier accès admin ; les comptes de
service de la CI sont gérés par `infra/iam`. Ces rôles existaient déjà, donnés à
la main : le premier apply les fait passer sous Terraform sans changer les accès
réels (sauf `billing.viewer`).

Retirer un email des `tfvars` retire réellement le rôle, même s'il avait été
donné à la main avant.

## Lecture des secrets Discord dev

Six attributions **additives** `google_secret_manager_secret_iam_member`, en dev
uniquement :

| Comptes Google | Secrets dans `cloud-pixelwar-dev` |
| --- | --- |
| `benjamin.melinette@gmail.com` | `discord-bot-token`, `discord-application-id` |
| `eliott603@gmail.com` | mêmes deux secrets |
| `zekyro.exe@gmail.com` | mêmes deux secrets |

Rôle : `roles/secretmanager.secretAccessor`. Les emails sont normalisés en
minuscules pour éviter les doublons de ressources Terraform.

Pas de lecture de secret en prd, ni sur OAuth, l'allow-list ou les autres secrets. Pas de
permission d'ajout de version, création de ressource ou gestion IAM accordée aux
développeurs par ce stack. Il ne supprime pas les droits existants/hérités hors
de ses propres attributions. La lecture autorise le contenu de **toutes les
versions** des deux secrets, pas seulement `latest`.

Aucune version/valeur n'est lue par Terraform. La réplication et les conteneurs
restent gérés par SRV-03 ; ce stack ne gère que les membres IAM.

## Appliquer

Avec ses propres identifiants (`gcloud auth application-default login`), après
merge sur `prod` :

```sh
cd infra/access
terraform init -reconfigure -backend-config=backends/<env>.hcl
terraform plan -var-file=<env>.tfvars -out=access.tfplan
terraform apply access.tfplan
```

Relire tout le plan : seules des attributions `editor`, `billing.viewer` (prd)
et `secretAccessor` (dev) doivent apparaître, sans suppression inattendue.
Le plan contient des emails : ne pas le committer.

Ajouter ou retirer un email dans les `tfvars` → PR, CI, revue, merge, puis
apply local. Retirer un email retire réellement le rôle, même s'il avait été
donné à la main avant.

## Après un destroy de `serverless`

Le destroy supprime les secrets **et leurs policies IAM** : conserver le state
access n'empêche pas cette suppression. Après recréation des secrets par
`serverless`, réappliquer `infra/access` dev, puis réinjecter les valeurs
depuis une source sûre.

## Migration depuis le workflow `access-dev` (une seule fois, dev)

L'ancien workflow utilisait un bucket dédié et deux identités WIF créées par
`infra/iam`. Dans cet ordre :

1. Copier le state vers le bucket dev commun :
   ```sh
   gcloud storage cp \
     gs://cloud-pixelwar-eliottmth-dev-access-tfstate/access/default.tfstate \
     gs://cloud-pixelwar-eliottmth-dev-tfstate/access/default.tfstate
   ```
2. Appliquer `infra/access` dev (voir ci-dessus) : le plan doit afficher
   **0 ajout, 0 changement, 0 destroy**. Sinon, arrêter et comparer les states.
3. Appliquer `infra/iam` dev à la main : il détruit les comptes
   `github-dev-access-*`, leurs rôles custom, le pool WIF `github-dev-access` et
   les environnements GitHub `access-dev*`. Le bucket dédié est seulement retiré
   du state (`removed.tf`), pas supprimé.
4. Supprimer le bucket dédié :
   ```sh
   gcloud storage rm --recursive gs://cloud-pixelwar-eliottmth-dev-access-tfstate
   ```

## Vérifications locales sans GCP

```sh
terraform init -backend=false -input=false -lockfile=readonly
terraform validate
terraform test
```

Les tests utilisent des providers simulés. Ils ne prouvent pas les droits réels
ni la propagation IAM.
