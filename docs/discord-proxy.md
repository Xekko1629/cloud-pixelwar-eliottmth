# Proxy Discord Q2 (BOT-03)

## Périmètre et état

`app/functions/discord-proxy/` fournit un handler HTTP Functions Framework
`handleDiscordProxy`. Cette livraison est **locale, non déployée**. Terraform
prépare les fonctions, topics, abonnements et droits de diagnostic dev ; aucun
apply n'a été exécuté. Le backend Gateway reste la sonde
[`discord-hello`](discord-hello.md) et le catalogue Discord n'est pas modifié.

Le proxy vérifie la signature Ed25519 du corps brut (fenêtre de timestamp
±5 minutes), répond au PING et publie `/draw` dans `discord-command`. Il attend
la confirmation Pub/Sub avant de répondre `200 { "type": 5 }`. Aucun traitement
n'est lancé après la réponse. Les autres commandes reçoivent une réponse
immédiate éphémère « pas encore disponible » sans publication.

Il ne dessine pas, ne consulte pas Firestore et n'applique ni quota, ni pause,
ni autorisation admin. La validation des options vérifie uniquement la forme,
les bornes techniques des coordonnées et les 16 couleurs, pas la taille de la
toile. Les interactions hors guilde ne sont pas prises en charge.

## Configuration du runtime futur

| Variable | Usage |
| --- | --- |
| `DISCORD_PUBLIC_KEY` | Clé publique Ed25519, 64 caractères hexadécimaux |
| `DISCORD_APPLICATION_ID` | Application attendue, contrôlée même au PING |
| `GOOGLE_CLOUD_PROJECT` | Projet qui porte le topic |
| `DISCORD_COMMAND_TOPIC` | Topic à publier, à provisionner séparément |

Une configuration incomplète produit un 503, y compris au PING. Aucun appel
réseau n'est effectué à l'import du handler. Le client Pub/Sub est initialisé
à la première commande, pas au PING.

## Contrat provisoire `discord-command`, version 1

Ce contrat est **à relire avec le propriétaire d'ARCH-03** avant le branchement
du consommateur. Ce document ne remplace pas le catalogue complet des événements.

| Champ | Contrat |
| --- | --- |
| `schema_version` | `1` |
| `event_id` | UUIDv8 dérivé de SHA-256 de `pixelwar:discord-command:v1:<application_id>:<interaction_id>` ; 128 bits, version et variante UUID fixées |
| `correlation_id` | Identique à `event_id` pour cette entrée |
| `occurred_at` | Date UTC millisecondes extraite du snowflake Discord, jamais de l'horloge au rejeu |
| `source` | `discord` |
| `actor` | `uid` Discord, `name` username, `roles` triés et dédupliqués |
| `payload.command` | `draw` |
| `payload.options` | `x`, `y`, `color`, entiers validés |
| `payload` (contexte) | `interaction_id`, `application_id`, `guild_id`, `channel_id`, `interaction_token` |

Les attributs Pub/Sub contiennent `correlation_id` et un `traceparent` W3C.
Le proxy démarre un span racine neuf après validation de la signature et de la
commande, sans reprendre le contexte de trace HTTP public. Le `correlation_id`
reste l'ID métier stable ; les traces peuvent être échantillonnées (`01`).
Le socle SRV-08 est branché, avec export avant réponse lorsqu'il est configuré ;
les tests locaux ne prouvent pas la réception par Cloud Trace. Voir
[le contrat d'observabilité](observability.md#instrumentation-des-fonctions-du-parcours-draw).

Le proxy ne déduplique pas : deux livraisons peuvent produire deux messages
avec la même identité métier. Le consommateur doit être idempotent. En cas de
timeout de publication, le message peut déjà avoir été accepté : un 503
n'implique pas l'absence de publication et ne garantit pas un retry Discord.

### Données sensibles

Le token d'interaction est nécessaire au futur notifier, mais expire après
15 minutes. Il figure uniquement dans le corps du message, jamais dans les
logs, attributs de trace, réponses d'erreur ou captures. Ne jamais journaliser
l'événement ou l'erreur brute du SDK. Les rôles sont des données de contexte,
pas une décision d'autorisation prise par le proxy.

SRV-05 devra restreindre l'accès au topic, aux abonnements et aux DLQ. Une
rétention longue ne prolonge pas la validité du token : les rejeux tardifs
devront séparer traitement métier et notification expirée.

## Tests locaux

Depuis `app/` :

```bash
npm ci
npm run typecheck
npm test -- functions/discord-proxy
npm run test:integration
npm run build:functions -- discord-proxy
```

Le test `app/testing/discord-proxy.integration.test.ts` utilise le projet factice
`demo-pixelwar-test`, un topic et un abonnement éphémères, ainsi qu'une requête
signée avec une clé générée en mémoire. Aucun secret Discord réel n'est requis.
Le garde-fou d'intégration refuse les endpoints d'émulateur distants et les
projets non factices. Voir [les tests](testing.md) pour Java et les émulateurs.

L'intégration appelle le handler et le vrai adaptateur Pub/Sub, puis lit le
message. Elle ne passe pas par un serveur HTTP réel, ni API Gateway, et ne
valide pas IAM/OIDC.

## Délai de réponse

L'adaptateur désactive les retries SDK, limite le RPC de publication à 1 seconde
et publie sans attendre un batch de plusieurs messages. Il attend réellement
la promesse du SDK : pas de `Promise.race` qui laisserait une publication en
arrière-plan après la réponse.

Ce délai RPC **ne borne pas toute l'initialisation** (credentials, connexion,
cold start). Le seuil Discord de 3 secondes doit être mesuré en dev, à froid et
à chaud. Ne pas déduire les performances du proxy des mesures de la sonde.

## Infrastructure dev préparée, non appliquée

Le [module topic Pub/Sub](../infra/serverless/modules/pubsub-topic/README.md)
est appelé dans `infra/serverless/discord-command.tf`. Le dispositif comprend :

- `discord-proxy.tf` : source, fonction proxy et références aux versions des secrets ;
- `discord-command.tf` : topic `discord-command`, publisher limité au runtime,
  worker privé `discord-command-verify`, abonnement push OIDC, topic
  `discord-command-verify-dlq` et abonnement pull `discord-command-verify-dlq-inspect` ;
- `google_project_service_identity` pour garantir l'existence de l'agent Pub/Sub
  géré par Google, sans deuxième runtime ou invoker en parallèle du module fonction ;
- tokenCreator sur l'invoker pour l'agent Pub/Sub, publisher sur la DLQ et
  subscriber sur l'abonnement source pour le transfert des messages en échec.

`enable_discord_pipeline` crée les fonctions, identités, topics, agent Pub/Sub
et abonnement DLQ **en dev seulement**. `enable_discord_delivery` active ensuite
tokenCreator, abonnement push et droits de transfert DLQ. `use_discord_proxy`
sélectionne enfin le backend exporté à la Gateway. `dev.tfvars` prépare seulement
la première phase : pipeline à `true`, livraison et routage proxy à `false`,
hello actif. Le routage proxy sans livraison et la livraison sans pipeline sont
refusés. En prd, ces flags n'ont aucun effet.

Le worker reçoit `APP_ENV=dev`, le nom complet `DISCORD_VERIFY_SUBSCRIPTION`
et `DISCORD_APPLICATION_ID` depuis Secret Manager. Son runtime n'a pas besoin
du droit subscriber pour recevoir un push. L'audience OIDC et l'endpoint sont
son URI. Le nom d'abonnement est une valeur locale partagée avec le worker,
sans dépendance circulaire fonction/abonnement.

| Paramètre | Valeur préparée |
| --- | --- |
| Instances proxy / worker | 0 minimum, 2 maximum chacun |
| Timeout worker / délai d'acquittement | 30 secondes chacun |
| Retry | 10 à 60 secondes |
| Tentatives DLQ | 5, seuil approximatif Pub/Sub |
| Rétention non acquittée source et DLQ | 7 jours (`604800s`) |
| Conservation après acquittement | Désactivée |
| Expiration des abonnements inactifs | Désactivée (`ttl = ""`) |

Les 7 jours ont été validés pour cet essai dev, y compris les tokens contenus
dans les messages : restreindre les lecteurs, ne jamais afficher de corps brut.
L'abonnement DLQ est créé avant le push ; le droit subscriber de transfert est
ajouté après la création de l'abonnement source. Attendre la fin de tout l'apply
et la propagation IAM avant publication. Aucune alerte DLQ n'est encore définie.

### Initialisation IAM ciblée, avant la livraison

`infra/iam/discord-verify.tf` prépare trois attributions sur le **seul compte
d'invocation du worker de diagnostic** :

| Bénéficiaire | Attribution sur ce compte |
| --- | --- |
| Deployer | Rôle personnalisé existant `deployerServiceAccountIamPolicy` : get/setIamPolicy |
| Deployer | `roles/iam.serviceAccountUser` : autorisation actAs explicite |
| Planner | Nouveau rôle personnalisé `discordVerifyIamPolicyRead` : seulement getIamPolicy |

`enable_discord_verify_iam` vaut `false` par défaut dans `infra/iam` et n'agit
qu'en dev. Il doit rester désactivé jusqu'à la création du compte par serverless.
Lorsqu'il est activé, une data source lit le compte existant : elle ne le crée
pas, ne l'importe pas et n'en change pas le propriétaire Terraform. Le nom
`invoke-e34c8c0323d1f404f6dd` suit le contrat de nommage du module fonction,
vérifié par un test dédié. Comparer avec l'output `discord_verify_invoker` de
serverless avant d'autoriser la phase IAM.

Le rôle de lecture est défini au niveau projet, mais **son attribution n'est
pas au niveau projet**. Aucun nouveau droit de gestion de tous les comptes de
service n'est ajouté. Les rôles larges préexistants du deployer ne sont pas
réduits ici. Le droit setIamPolicy permet de modifier les attributions sur ce
compte, pas seulement tokenCreator : portée restreinte, mais pouvoir sensible.

La phase IAM doit être exécutée par une identité déjà autorisée à modifier
cette politique, pas par le deployer qui cherche à obtenir ce droit. Après
revue et accord, persister son flag dans la configuration dev ; ne pas le
revenir à `false` au run suivant, ce qui planifierait le retrait des droits.
Le flag est volontairement laissé à sa valeur par défaut dans cette livraison.

Après application IAM et propagation, la phase livraison peut ajouter le droit
tokenCreator de Pub/Sub. Les flags n'attestent pas que les droits réels sont
effectifs : vérifier aussi génération de l'agent et permissions des plans CI.
La consultation documentaire Pub/Sub du 17 novembre 2026 confirme actAs pour
le créateur du push et getOpenIdToken/tokenCreator pour l'agent :
[authentification des abonnements push](https://cloud.google.com/pubsub/docs/authenticate-push-subscriptions).

### Tests locaux

Après build des fonctions, dans `infra/serverless` :

```bash
terraform init -backend=false -input=false
terraform validate
terraform test
```

`tests/discord-pipeline.tftest.hcl` simule tous les providers, même pour ses
runs `command = apply` : aucun apply GCP, state distant ou lecture de secret.
Il vérifie dev/prd, OIDC, retries/DLQ, rétention et sélection indépendante du
backend. Les tests des modules sont exécutés séparément.
`infra/iam/tests/discord-verify.tftest.hcl` utilise également exclusivement des
mocks pour vérifier l'opt-in dev, les trois attributions ciblées et la lecture
seule du planner. Ces tests ne prouvent pas l'accès effectif dans GCP.

## Déploiement ultérieur (accords séparés requis)

1. Faire relire le contrat avec Incognito et valider les plans des phases ci-dessous.
2. Vérifier les métadonnées des versions de secrets, sans afficher les valeurs.
3. Phase ressources : plan/apply serverless dev, livraison et routage proxy
   désactivés. Le backend reste hello ; aucun abonnement source n'existe encore,
   donc **aucune publication d'essai** n'est permise à cette phase.
4. Phase IAM : comparer l'invoker créé avec la cible attendue, préparer le flag
   IAM dev persistant, revoir le plan et autoriser l'apply IAM par l'opérateur.
5. Phase livraison : préparer `enable_discord_delivery=true`, revoir le plan
   serverless et autoriser l'apply. Attendre l'abonnement source et tous les
   droits ; la Gateway reste sur hello.
6. Lors d'une étape distincte approuvée, sélectionner `use_discord_proxy=true`,
   appliquer serverless pour actualiser le contrat, puis revoir le vrai plan
   Gateway avant d'autoriser la bascule. Un plan Gateway antérieur lit encore
   le contrat précédent : il ne prouve pas la future bascule.
7. Prévisualiser puis autoriser séparément le mode ciblé `--draw` du
   [CLI d'enregistrement](discord-commands.md) : GET puis POST/PATCH en dev.
   Ce mode est implémenté et testé localement, pas exécuté sur Discord.
   Ne pas utiliser le PUT global qui remplace le catalogue.
8. Vérifier refus IAM/signature, commande Discord, consommation dans les logs
   sûrs du worker et latences à froid/chaud. Les tests PING locaux ne prouvent
   pas le callback réel.

Le workflow `Deploy` actuel enchaîne plan/apply puis Gateway sans pause de
revue entre eux. Ne pas le déclencher comme s'il garantissait ces accords
séparés : le mécanisme d'exécution devra être choisi avant déploiement.
Aucun workflow de déploiement n'est modifié ici.

Pour revenir à hello, laisser pipeline et livraison actifs, garder hello
actif et changer seulement `use_discord_proxy=false`, puis appliquer les deux
stacks dans l'ordre après accords. Désactiver le dispositif planifierait sa
suppression : ce n'est pas un rollback de routage. Lors de la future bascule,
`/hello` ne fonctionnera plus dans le proxy même si sa fonction est conservée.

La désactivation de la livraison planifierait la suppression de l'abonnement
source et de ses droits : ce n'est pas une pause réversible des messages.
Pour un nettoyage approuvé, retirer d'abord le trafic et la livraison, puis
les attributions IAM dev **avant** de supprimer l'invoker côté serverless.
Sinon la data source IAM échouerait sur un compte absent. Une recréation du
compte demande une nouvelle vérification de ses droits. Ne pas migrer les
comptes entre states pour contourner cet ordre.

Sans `discord-notifier`, la réponse différée restera en attente dans Discord.
La preuve Q2 est la publication dans Pub/Sub, pas un pixel dessiné ni une
notification de succès. Cette livraison seule ne clôt donc pas BOT-03 en cloud.
