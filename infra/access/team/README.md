# Accès humains — équipe et instructeur (ACC-01)

Stack séparé des workloads (sujet §2.1, C03 §9) : un `destroy` de `foundation`, `runners` ou `serverless` ne retire l'accès à personne. Aucun workflow ne l'applique ni ne le détruit.

## Ce qu'il gère

| Principal | Rôle | Où |
| --- | --- | --- |
| Membres de `team_editors` | `roles/editor` | projet dev et projet prd |
| Instructeur (`jeremie@jjaouen.com`) | `roles/editor` | projet dev et projet prd |
| Instructeur | `roles/billing.viewer` | compte de facturation `0111A1-F02A73-B2E667`, géré par l'environnement prd seulement (le compte est commun aux deux projets) |

Les attributions sont **additives** (`google_project_iam_member`, `google_billing_account_iam_member`) : elles ne remplacent jamais la policy complète. Le rôle `roles/owner` d'Eliott reste volontairement hors Terraform, pour qu'une erreur dans ce stack ne puisse pas retirer le dernier accès admin. Les comptes de service de la CI sont gérés par `infra/iam`.

L'accès des développeurs aux deux secrets Discord de dev est dans le stack parent `infra/access`, avec son propre state et son workflow. Les deux states sont séparés parce que le compte de service de ce workflow ne doit pas pouvoir modifier l'IAM des projets.

## Appliquer

Ce stack s'applique **en local, par un owner du projet qui est aussi admin du compte de facturation** (aujourd'hui Eliott), avec ses identifiants `gcloud auth application-default login`. Aucun compte de service de CI ne reçoit `projectIamAdmin` ni de droit sur le compte de facturation.

```sh
cd infra/access/team
terraform init -reconfigure -backend-config=backends/dev.hcl
terraform plan -var-file=dev.tfvars -out=team.tfplan
terraform apply team.tfplan

terraform init -reconfigure -backend-config=backends/prd.hcl
terraform plan -var-file=prd.tfvars -out=team.tfplan
terraform apply team.tfplan
```

Plans attendus au premier apply : **3 ajouts en dev, 4 en prd, aucun changement ni suppression**. Ces droits existent déjà (donnés à la main) : l'apply ne change donc rien aux accès réels, il les fait passer sous Terraform.

Le state est dans le bucket de state de chaque environnement, préfixe `access-team`.

## Modifier

Ajouter ou retirer un email dans `dev.tfvars` et `prd.tfvars`, puis PR, revue, merge et nouvel apply local.

Retirer un email d'ici (ou détruire ce stack) **retire réellement** le rôle, y compris s'il avait été donné à la main avant. À faire seulement en connaissance de cause.

## Vérifier

```sh
gcloud projects get-iam-policy cloud-pixelwar-prod \
  --flatten=bindings --filter="bindings.members~^user:" \
  --format="table(bindings.role,bindings.members)"
gcloud billing accounts get-iam-policy 0111A1-F02A73-B2E667
```

Tests sans GCP : `terraform init -backend=false && terraform test`.
