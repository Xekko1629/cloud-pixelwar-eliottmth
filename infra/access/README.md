# Accès humains — lecture Discord dev

Extension limitée du chantier ACC-01 (#8), à coordonner avec son responsable :
ceci ne termine pas les rôles généraux de l'équipe ni les accès de l'instructeur
et de facturation prévus par ce ticket. Ceux-ci sont dans le sous-stack
[`team/`](team/README.md), avec un state séparé.

## Périmètre validé

Six attributions **additives** `google_secret_manager_secret_iam_member` :

| Comptes Google | Secrets dans `cloud-pixelwar-dev` |
| --- | --- |
| `benjamin.melinette@gmail.com` | `discord-bot-token`, `discord-application-id` |
| `eliott603@gmail.com` | mêmes deux secrets |
| `zekyro.exe@gmail.com` | mêmes deux secrets |

Rôle : `roles/secretmanager.secretAccessor`. Les emails sont normalisés en
minuscules pour éviter les doublons de ressources Terraform.

Pas de nouveau droit sur prd, OAuth, l'allow-list ou les autres secrets. Pas de
permission d'ajout de version, création de ressource ou gestion IAM accordée aux
développeurs par ce stack. Il ne supprime pas les droits existants/hérités hors
de ses propres attributions. La lecture autorise le contenu de **toutes les
versions** des deux secrets, pas seulement `latest`.

Aucune version/valeur n'est lue par Terraform. La réplication et les conteneurs
restent gérés par SRV-03 ; ce stack ne gère que les membres IAM.

## States et séparation des pouvoirs

- `infra/iam`, state existant `iam` : initialise l'automatisation persistante.
- `infra/access`, préfixe `access`, bucket **dédié**
  `cloud-pixelwar-eliottmth-dev-access-tfstate` : contient les six attributions.
- Ni `iam` ni `access` ne sont appelés par le workflow de destruction.
- Deux nouvelles identités, sans clé GCP persistante :
  - `github-dev-access-plan` : `getIamPolicy` uniquement sur les deux secrets ;
  - `github-dev-access-apply` : `getIamPolicy` + `setIamPolicy` sur ces secrets.
- Les deux ont `storage.objectAdmin` sur **le seul bucket access**, pour
  initialiser le backend, lire le state et gérer les verrous. Le plan est donc
  en lecture seule pour l'IAM des secrets, **pas pour ce backend isolé**.
  Aucun accès aux autres states n'est ajouté par cette configuration.

L'identité apply n'a pas directement `versions.access`, mais **gérer une policy
IAM est un privilège sensible** : elle pourrait accorder cette lecture. La
protection repose donc aussi sur le workflow fixe, la branche et la revue admin.
Il ne faut pas présenter cette identité comme incapable d'obtenir une valeur.

WIF utilise un pool dédié et vérifie le nom et l'ID numérique du dépôt, l'ID
numérique du propriétaire Xekko, `refs/heads/prod`, l'événement manuel, le chemin
exact `access-dev.yml` et l'environnement plan/apply. Les attributions au compte
de service séparent ensuite les environnements `access-dev-plan` et `access-dev`.
Le pool WIF et les droits du deployer historique ne sont pas élargis.

## Initialisation unique par Xekko — aucun auto-bootstrap

Le workflow ne peut pas créer son propre compte ni ses protections. Après revue
et merge, Xekko doit appliquer **une fois** le stack IAM dev modifié, avec ses
identités Google/Terraform et GitHub autorisées. Les deux secrets dev et le
backend IAM existant doivent déjà être présents. Ne pas réutiliser un token bot
Discord comme token GitHub.

Exemple depuis `infra/iam`, sans traçage shell (`set -x`) :

```sh
terraform init -reconfigure -backend-config=backends/dev.hcl
GITHUB_TOKEN="$(gh auth token)" terraform plan -var-file=dev.tfvars -out=dev-access-bootstrap.tfplan
```

Relire **tout le plan IAM**, pas seulement les ajouts : nouveau bucket privé,
deux comptes, deux rôles limités, WIF et deux environnements GitHub. Aucun rôle
de lecture des valeurs au niveau projet, aucun nouveau droit prd et aucune
suppression inattendue. Après accord explicite, Xekko peut appliquer ce plan :

```sh
GITHUB_TOKEN="$(gh auth token)" terraform apply dev-access-bootstrap.tfplan
```

Ce n'est pas exécuté par l'assistant, une PR ou le workflow habituel Deploy.
`enable_dev_secret_access = true` n'est activé que dans `infra/iam/dev.tfvars` ;
le défaut est false et toute activation en prd est refusée.

Vérifier ensuite dans GitHub :
- `access-dev-plan` : branche `prod` uniquement, variables `WIF_PROVIDER` et
  `ACCESS_SA` du compte plan, pas de revue requise pour produire le plan ;
- `access-dev` : branche `prod` uniquement, **Xekko1629 seul reviewer**,
  contournement des protections par les administrateurs désactivé, variables
  WIF et compte apply distinct ;
- Xekko peut approuver son propre déclenchement (`prevent_self_review = false`)
  car il est l'unique admin désigné. Ce n'est pas une règle à deux approbateurs.

Si les protections ne sont pas disponibles ou ne sont pas réellement appliquées,
**arrêter** : ne pas remplacer l'environnement par le dev non protégé.

## Utilisation du bouton après initialisation

1. GitHub Actions → **Dev Discord secret access** → **Run workflow**.
2. Choisir la branche **`prod`** et confirmer **`cloud-pixelwar-dev`**.
3. Le job plan calcule le plan sur le commit exact du run et le publie dans son
   résumé. À la première exécution, attendre **6 ajouts, 0 changement, 0 destroy**.
4. Xekko relit le résumé et approuve l'environnement **`access-dev`**.
5. Le job apply vérifie le SHA-256 puis applique **le fichier plan sauvegardé**,
   sans recalculer un nouveau plan après approbation.

Un seul run à la fois ; verrous Terraform conservés. L'artefact ne reste qu'un
jour : s'il expire ou si le state change, relancer et refaire valider le plan.
Le plan expose des métadonnées IAM et les emails, pas les valeurs des secrets ;
il doit néanmoins être traité comme un artefact d'administration sensible.

Après propagation IAM, chaque développeur peut relancer le bloc BOT-02 qui lit
le token dans une variable de sous-processus puis enregistre les commandes dev.
Ne pas afficher le token pour tester son accès, ni le copier dans Git/le chat.
Le bouton **n'enregistre pas** lui-même les commandes Discord.

## Modifications et reconstruction

Ajouter/retirer un email dans `dev.tfvars` → PR, CI, revue, merge, nouveau plan
et approbation. La suppression d'un membre géré retire seulement son attribution
sur ces deux secrets, pas ses éventuels droits hérités ou accordés ailleurs.

Un destroy de `serverless` supprime les secrets **et leurs policies IAM** :
conserver le state access n'empêche pas cette suppression. Après recréation des
secrets, Xekko doit réappliquer le bootstrap IAM pour restaurer les permissions
des identités d'automatisation, puis relancer le workflow access. Les valeurs
des secrets restent à réinjecter séparément depuis une source sûre.

Le bucket est privé, versionné, `force_destroy = false` et protégé par
`prevent_destroy`. Les anciennes générations archivées sont nettoyées seulement
si elles ont plus de 30 jours et au moins 20 générations plus récentes. Cela
ajoute un petit coût GCS à l'usage, pas du compute permanent ni un plafond de
facturation. `prevent_destroy` protège l'opération Terraform, pas contre tous
les actes possibles d'un administrateur GCP.

## Vérifications locales sans GCP

Depuis `infra/access` puis `infra/iam` :

```sh
terraform init -backend=false -input=false -lockfile=readonly
terraform validate
terraform test
```

Les tests utilisent des providers simulés. Ils ne prouvent pas les droits réels,
la propagation IAM, les protections GitHub actives ni le succès du premier run.
La CI valide/teste access, mais n'exécute aucun plan distant ou apply de ce stack
sur une PR. Le cycle Deploy/Destroy des applications reste inchangé.
