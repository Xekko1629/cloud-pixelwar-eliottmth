# Secrets applicatifs

Terraform déclare les conteneurs Secret Manager, **jamais leurs valeurs ni leurs
versions**. Aucune ressource `google_secret_manager_secret_version` n'est utilisée :
les valeurs ne transitent pas dans le plan ni dans le state via ce code.

## Catalogue et consommateurs

| ID du secret | Contenu | Usage |
| --- | --- | --- |
| `discord-public-key` | Clé publique Ed25519 de l'application Discord | Vérification de signature du callback (`discord-hello` ou proxy configuré) |
| `discord-bot-token` | Token du bot, uniquement si l'appel Discord utilisé le nécessite | À attribuer aux seules fonctions qui en ont réellement besoin |
| `discord-application-id` | ID de l'application Discord | Script d'enregistrement des commandes, fonctions qui utilisent cet ID |
| `discord-oauth-client-secret` | Client secret OAuth2 Discord | `auth-proxy` |
| `admin-allowlist` | Tableau JSON d'IDs Discord autorisés, par exemple `["123456789"]` | `command-worker` pour les commandes admin |

La clé publique et l'application ID ne sont pas confidentiels ; ils sont placés
ici pour centraliser la configuration Discord. Les IDs doivent être des chaînes,
pas des nombres JS. Le consommateur valide le format de l'allow-list ; `[]` refuse
tous les utilisateurs si cette liste est la seule méthode d'autorisation.

Les callbacks Discord à token d'interaction n'exigent pas nécessairement le token
du bot : ne pas attribuer cet accès par défaut à tous les notifiers.

## Où vivent les secrets

- Les conteneurs sont déclarés dans `infra/iam/secrets.tf`, stack **persistant
  appliqué à la main**, jamais par Deploy ni Destroy. Secret Manager est la
  source de vérité des secrets d'exécution (sujet C04 §5) : un destroy de
  `serverless` ne supprime ni les conteneurs ni les valeurs.
- `deletion_protection = true` : un apply qui voudrait supprimer un secret échoue.
- L'API Secret Manager est activée par `infra/iam/apis.tf`.
- Le deployer de la CI n'a que `getIamPolicy`/`setIamPolicy` sur chacun de ces
  secrets (`deployer-iam.tf`) : il peut donner `secretAccessor` à une fonction
  depuis `infra/serverless`, pas lire ni écrire une valeur.
- Pour une adoption de conteneurs existants, activer `import_application_secrets`
  et examiner les imports du plan. Pour une installation vide, désactiver cette
  option : voir le [guide de déploiement](../../docs/deployment.md).
  `infra/serverless/removed.tf` conserve la transition sans destruction des secrets
  retirés de ce state ; vérifier les states avant toute autre migration.
- Créer un conteneur ne suffit pas à démarrer les fonctions : une version
  référencée doit exister et l'identité d'exécution doit avoir les permissions.
- Coût : quelques centimes par mois de versions actives, conservés après un
  destroy. Choix assumé : sans eux, la source de vérité disparaîtrait.

## Ajouter une valeur hors du dépôt

Faire l'opération séparément pour `cloud-pixelwar-dev` et `cloud-pixelwar-prod`.
Utiliser une identité humaine autorisée à ajouter des versions au secret concerné.
Ne pas envoyer les valeurs dans un chat, une PR, une commande en clair dans
l'historique shell ou les logs de CI.

Exemple, à adapter, après création du conteneur :

```sh
gcloud secrets versions add discord-bot-token \
  --project=cloud-pixelwar-dev \
  --data-file=/chemin/hors-du-repo/discord-bot-token.txt
```

Le fichier doit être accessible uniquement à son propriétaire et contenir la
valeur exacte, sans saut de ligne ajouté involontairement. Retirer ce fichier
après l'opération selon les règles de stockage sécurisé de votre poste.
La console Secret Manager est aussi utilisable sans fichier temporaire.

Utiliser les informations de l'application Discord **dev pour dev**, et celles
de l'application **prd pour prd**. Créer/configurer les applications externes
avant d'alimenter leurs valeurs ; ne pas substituer de fausses données.

Vérifier l'existence et l'état des versions sans afficher leur contenu :

```sh
gcloud secrets versions list discord-bot-token --project=cloud-pixelwar-dev
```

## Accès IAM limités par consommateur

Le module `function` accorde `roles/secretmanager.secretAccessor` **sur chaque
secret référencé**, au compte d'exécution de cette fonction, pas au niveau projet.
Exemple de référence dans un appel au module :

```hcl
secrets = {
  DISCORD_PUBLIC_KEY = {
    secret  = "discord-public-key"
    version = "1"
  }
}
```

Ce bloc s'ajoute à l'appel du module du proxy, pas seul à la racine du stack.
Remplacer `1` par le numéro réel de la version ajoutée. Le secret existe déjà
(stack `iam`), seul son ID est passé ; ne pas donner au proxy accès à tous les
secrets. L'identité de l'outil d'enregistrement a des accès ciblés aux deux
secrets décrits dans [son guide](../../docs/discord-commands.md).

Après déploiement, contrôler la policy du secret et l'identité runtime, puis
vérifier un accès autorisé et un refus avec une identité non autorisée. Une
version activée et un plan valide ne prouvent pas à eux seuls la lecture runtime.

## Rotation et destruction

- Rotation : ajouter une nouvelle version hors Terraform, mettre à jour la
  référence numérique de la fonction et déployer. Désactiver l'ancienne version après
  validation et vérification des besoins de rollback ; ne pas la supprimer à l'aveugle.
- Destroy : le workflow `Destroy` ne touche pas `infra/iam`, les secrets et leurs
  valeurs sont conservés. Supprimer un secret demande de retirer d'abord
  `deletion_protection`, par une PR relue.
- Facturation : le stockage des versions et les accès Secret Manager peuvent être
  facturés ; conserver seulement les versions nécessaires.

## Vérifications sans GCP

Depuis `infra/iam` :

```sh
terraform init -backend=false
terraform fmt -check
terraform validate
terraform test
```

Les tests utilisent un provider simulé. Ils vérifient le catalogue, la
protection contre la suppression et les droits limités du deployer, pas les
valeurs ni les accès réels.
