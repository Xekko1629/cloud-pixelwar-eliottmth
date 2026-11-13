# Architecture

## Périmètre et références

L'application sépare l'entrée HTTP, le traitement événementiel et les données.
Les décisions détaillées sont dans [les ADR](adr/README.md) ; les modules et
workflows versionnés déterminent les ressources déclarées pour une installation.
Ce document décrit les responsabilités et contrats, pas un inventaire GCP.

## Vues d'architecture

### Architecture générale — Draw.io

Le [fichier Draw.io éditable](architecture/pixelwar.drawio) rassemble trois pages.
Le [modèle sémantique](architecture/pixelwar.ir.json) conserve les références au
code, aux ADR et aux tickets du [GitHub Project](https://github.com/users/Xekko1629/projects/3).
Les images ci-dessous se consultent sans installer Draw.io ; ouvrir le fichier
éditable dans l'application ou l'importer dans [diagrams.net](https://app.diagrams.net/).

| Page | Portée | Aperçu |
| --- | --- | --- |
| Application actuelle | Parcours de la sonde dev et bibliothèques implémentées, sans présumer de leur déploiement | [PNG](architecture/pixelwar-actuel.png) |
| Application cible | Dessin Discord/web, authentification, événements, workers, données, rendus et snapshots | [PNG](architecture/pixelwar-cible.png) |
| Plateforme et exploitation | CI/CD, identités, construction des fonctions, runners et supervision | [PNG](architecture/pixelwar-plateforme.png) |

La cible suit les ADR actifs lorsqu'un ticket contient un contrat remplacé,
notamment ADR-0009 pour les sources des fonctions. Les lectures directes du
navigateur sont signalées comme proposées (ADR-0004), et le mode de lecture des
images `overview` reste à arbitrer. Grafana est optionnel et n'est pas représenté.
Draw.io est ici un complément documentaire ; il ne satisfait pas la restriction
d'outil énoncée dans le ticket [ARCH-02 #27](https://github.com/Xekko1629/cloud-pixelwar-eliottmth/issues/27).

### Vues détaillées — Archify

Les vues interactives sont générées depuis les spécifications JSON versionnées
dans `docs/architecture/`. Elles s'ouvrent directement dans un navigateur, sans
serveur, et décrivent les contrats du dépôt : elles ne constatent pas l'état d'un
déploiement GCP.

| Vue | Portée | Spécification |
| --- | --- | --- |
| [Parcours Discord](architecture/parcours-discord.html) | Callback public de la sonde dev : Gateway, contrôle Ed25519, secret et journal | [JSON](architecture/parcours-discord.json) |
| [Socle de déploiement](architecture/socle-deploiement.html) | Identités, fédération WIF, state GCS et ordre des stacks Terraform | [JSON](architecture/socle-deploiement.json) |
| [Séquence du callback](architecture/sequence-callback.html) | PING, commande `hello` et refus d'une signature invalide | [JSON](architecture/sequence-callback.json) |

Les diagrammes ne remplacent pas les ADR ni les runbooks : une relation absente
d'une vue ne vaut pas autorisation, et une relation représentée ne vaut pas
preuve de déploiement.

La [procédure de maintenance des diagrammes](architecture/README.md) décrit
leur consultation, leurs références au code et leur régénération.

## Composants et frontières

| Composant | Responsabilité | Frontière |
| --- | --- | --- |
| API Gateway | Routage HTTP et validation Firebase des routes protégées | Point d'entrée HTTP des proxies |
| Fonction proxy | Validation de la requête et publication de l'événement | Invocation IAM par l'identité Gateway |
| Pub/Sub | Distribution par topic/abonnement, retries et DLQ | Push OIDC avec une identité d'invocation dédiée |
| Fonction worker | Traitement durable et idempotent avant acquittement | Ingress interne, runtime distinct de l'invoker |
| Secret Manager | Valeurs sensibles et versions | Accès runtime secret par secret |
| Sources GCS et Artifact Registry | Sources et images internes des fonctions | Identité de build distincte du runtime |
| GKE et ARC | Exécution et autoscaling des runners CI | Aucun hébergement du backend applicatif |

Les contrats de données, identité web, temps réel et hébergement sont décrits
respectivement par ADR-0007, ADR-0005, ADR-0003 et ADR-0006. ADR-0004 décrit une
**proposition** de lectures directes Firestore ; ce statut ne doit pas être
assimilé à une exception approuvée. Les runbooks d'un composant déployable
doivent correspondre à ses modules et handlers, pas seulement à un ADR.

## Entrée HTTP et événements

API Gateway appelle les proxies avec son identité Google et l'audience de leur
URL de fonction. Les proxies autorisent cet accès réseau, mais pas l'invocation
anonyme. La validation JWT utilisateur à la Gateway et l'authentification IAM du
backend sont deux contrôles distincts.

Le callback Discord est public à la Gateway pour recevoir les requêtes Discord ;
le handler vérifie Ed25519 sur le corps brut. La [sonde hello](discord-hello.md)
répond directement pour tester ce contrat HTTP. Elle ne représente pas le
traitement événementiel des commandes métier.

Pour le flux métier, un proxy attend la publication avant de répondre. Pub/Sub
pousse ensuite vers le worker. Un 2xx acquitte le message ; une erreur technique
non-2xx permet le retry. La livraison est au moins une fois, sans ordre garanti :
les écritures et publications doivent traiter doublons et interruptions. Voir
ADR-0002 et le [contrat transactionnel des quotas](rate-limits.md).

## Sources et déploiement

Les sources TypeScript de la fonction et du paquet partagé sont regroupées par
esbuild ; les paquets npm restent externes. Terraform crée le ZIP, le téléverse
et référence sa génération GCS. Google construit l'image avec l'identité de build
et l'exécute avec celle du runtime.

ADR-0009 remplace le contrat de promotion d'archive d'ADR-0008 : chaque
environnement construit depuis le commit choisi, sans garantie de mêmes octets
ou de mêmes transitives installées. Le frontend et les services externes ont
leurs propres contrats ; une archive backend ne constitue pas leur déploiement.

Les responsabilités des stacks, l'initialisation des backends et l'ordre des
opérations sont décrits dans [Installation et déploiement](deployment.md).

Le [contrat proposé par ADR-0010](adr/0010-separation-gateway-serverless.md)
sépare les states `serverless` (fonctions) et `gateway` (entrée HTTP). Le second
consomme un contrat d'outputs après l'apply du premier ; sa création de config
avant suppression ne se propage donc pas dans le graphe des fonctions. Cette
séparation ne garantit pas l'absence d'interruption lors du remplacement d'une fonction.
