# Module topic Pub/Sub et publication IAM

Prépare un topic d'événement et des droits **additifs** `roles/pubsub.publisher`
limités à ce topic. Ne crée ni compte de service, ni droit projet, ni accès
anonyme. Les identités viennent des modules de fonctions, jamais d'un compte
provisoire créé pour anticiper le déploiement.

## Raccordement prévu pour Discord

Le stack appelle maintenant ce module dans `discord-command.tf`, avec un
garde-fou dev-only. Exemple simplifié : adapter les indices `[0]` pour les
modules conditionnels réels.

```hcl
module "discord_commands" {
  source     = "./modules/pubsub-topic"
  project_id = var.project_id
  name       = "discord-command"
  publishers = {
    discord = module.discord_proxy.service_account_member
  }
}
```

Le runtime du proxy reçoit `DISCORD_COMMAND_TOPIC = "discord-command"` et
`GOOGLE_CLOUD_PROJECT = var.project_id`. Utiliser le nom connu du topic dans
ses variables, pas un output du module topic : le module topic dépend de
l'identité exportée du module fonction ; une dépendance inverse sur tout le
module pourrait créer un cycle. Si les modules utilisent `count`, adapter les
indices et le même garde-fou d'activation dev pour les deux.

Les clés de `publishers` (`discord`, etc.) sont stables au plan, même si leurs
valeurs ne sont connues qu'à l'apply. Ne pas utiliser un `set` d'emails calculés
comme clés Terraform. Le membre exporté crée la dépendance vers l'identité
runtime ; ne pas remplacer cette référence par un email construit à la main.

Le rôle de publication est distinct des rôles suivants :

- `run.invoker` de l'identité Gateway sur le proxy ;
- `run.invoker` de l'identité OIDC Pub/Sub sur le futur worker ;
- `iam.serviceAccountTokenCreator` de l'agent Pub/Sub sur cette identité OIDC ;
- `pubsub.subscriber` d'un consommateur ou inspecteur.

Ces droits ne sont **pas accordés par ce module**. Le raccordement dev les
décrit dans `discord-command.tf` et le module fonction. Le build, la Gateway
et la sonde hello ne reçoivent aucun droit publisher implicite.

## Hors périmètre et rétention

Ce module ne crée pas d'abonnement, DLQ, schéma Pub/Sub, alerte ou identité de
service Pub/Sub. Le stack appelant prépare maintenant les abonnements et droits
du worker de diagnostic. SRV-05 reste incomplet : aucun essai dev ni alerte DLQ,
et le futur catalogue de workers reste à raccorder (ADR-0002).
L'API Pub/Sub est déjà déclarée dans `infra/iam/apis.tf` ; elle doit être activée
avant tout futur apply de ressources Pub/Sub.

Aucune rétention au niveau topic n'est configurée : sans abonnement créé
avant publication, il n'y a pas de garantie de conservation pour un futur
consommateur. Le stack prépare un abonnement push de vérification et un
abonnement DLQ d'inspection avec 7 jours de rétention non acquittée, validés
pour l'essai dev. Ils doivent exister avec tous leurs droits avant les essais.
Ils restent distincts du futur consommateur métier ; seuls des essais réels
pourront prouver le push OIDC, les retries et le transfert DLQ.

Le corps des messages contient le token d'interaction Discord : limiter les
lecteurs, ne jamais afficher un message brut en démonstration, et ne pas
confondre les 15 minutes de validité du token avec la rétention des messages.

## Tests sans GCP

```bash
terraform init -backend=false -input=false
terraform validate
terraform test
```

Les tests utilisent `mock_provider "google"` et ne lisent ni state distant,
ni credentials, ni valeurs de secrets. Ils vérifient les ressources déclarées,
pas les droits effectifs d'une identité réelle dans GCP. `enable_discord_pipeline`
active son appel en dev seulement ; `dev.tfvars` le prépare à `true`. Aucun apply
n'a été exécuté. La sélection Gateway reste sur hello. Voir
[le guide proxy](../../../../docs/discord-proxy.md) pour le prérequis IAM du
deployer et les validations avant déploiement.
