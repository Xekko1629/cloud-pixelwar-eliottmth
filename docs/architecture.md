# Architecture

## Périmètre et références

L'application sépare l'entrée HTTP, le traitement événementiel et les données.
Les décisions détaillées sont dans [les ADR](adr/README.md) ; les modules et
workflows versionnés déterminent les ressources déclarées pour une installation.
Ce document décrit les responsabilités et contrats, pas un inventaire GCP.

## Composants et frontières

| Composant | Responsabilité | Frontière |
| --- | --- | --- |
| Frontend (Cloud Run) | Image nginx qui sert l'application React (ADR-0011) | Seul service public ; aucun rôle GCP |
| API Gateway | Routage HTTP et validation du JWT de session des routes protégées (ADR-0012) | Point d'entrée HTTP des proxies |
| Listeners Firestore (navigateur) | Temps réel : deltas des régions visibles et `config/global` (ADR-0015) | Security Rules : lecture seule de ces deux chemins, aucune écriture |
| Fonction proxy | Validation de la requête et publication de l'événement | Invocation IAM par l'identité Gateway |
| Pub/Sub | Distribution par topic/abonnement, retries et DLQ | Push OIDC avec une identité d'invocation dédiée |
| Fonction worker | Traitement durable et idempotent avant acquittement | Ingress interne, runtime distinct de l'invoker |
| Firestore | Tuiles, deltas, état utilisateur, config et déduplication (ADR-0007), index, TTL et règles en Terraform | IAM par compte d'exécution pour les fonctions ; navigateur limité par les règles à la lecture des deltas et de `config/global` |
| Secret Manager | Valeurs sensibles et versions | Accès runtime secret par secret |
| Sources GCS et Artifact Registry | Sources et images internes des fonctions | Identité de build distincte du runtime |
| GKE et ARC | Exécution et autoscaling des runners CI | Aucun hébergement du backend applicatif |

Les contrats de données, identité web, temps réel et hébergement sont décrits
respectivement par ADR-0007, ADR-0012, ADR-0015 et ADR-0011. Ni
Firebase Hosting ni Firebase Auth ne sont utilisés (revue intermédiaire). Le
navigateur n'écrit jamais dans Firestore : ses écritures et ses lectures
ponctuelles passent par la gateway. Son temps réel vient de listeners Firestore,
avec la seule librairie cliente `firebase/firestore`, limités par les règles à la
lecture des deltas et de `config/global` (ADR-0015). Le dessin publie un
événement par pixel (ADR-0014). Les runbooks d'un composant déployable
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
