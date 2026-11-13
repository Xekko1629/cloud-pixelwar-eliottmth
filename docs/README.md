# Documentation technique

## Installation et exploitation

- [Outillage et préparation du poste](outillage.md)
- [Installation initiale, déploiement, reprise et suppression](deployment.md)
- [Configuration GCP, quotas et maîtrise des coûts](gcp.md)
- [Accès humains et lecture des secrets Discord dev](../infra/access/README.md)
- [Création, alimentation et rotation des secrets](../infra/iam/SECRETS.md)
- [Déploiement du stack serverless](../infra/serverless/README.md)
- [Gateway, contrat des backends et migration des states](../infra/gateway/README.md)

## Développement et intégration

- [Contribution, signature et releases](gitflow.md)
- [Fonctionnement des workflows CI/CD](ci.md)
- [Tests applicatifs et émulateurs](testing.md)
- [Structure, construction et déploiement des fonctions](functions.md)
- [Enregistrement des commandes Discord](discord-commands.md)
- [Installation, vérification et retrait de la sonde Discord hello](discord-hello.md)
- [Contrat du calcul des quotas utilisateur](rate-limits.md)
- [Instrumentation et validation de l'observabilité](observability.md)

## Architecture et modules

- [Architecture et frontières de sécurité](architecture.md)
- [Décisions d'architecture et règles de rédaction](adr/README.md)
- [Module Cloud Run function](../infra/serverless/modules/function/README.md)
- [Module API Gateway](../infra/serverless/modules/api-gateway/README.md)

Les procédures correspondent au code de la version consultée. Elles ne
constituent pas un inventaire des ressources réellement déployées. Le suivi
d'avancement et les preuves d'exécution appartiennent aux issues, PR, rapports CI
et au [GitHub Project](https://github.com/users/Xekko1629/projects/3).

## Convention de rédaction

Rédiger les titres et la prose en français, sans traduire les noms de produits,
commandes, chemins ou identifiants d'API. Décrire des contrats et prérequis
vérifiables, pas l'avancement d'un ticket ou l'état supposé d'un environnement.
Les procédures distinguent installation vide, mise à jour et migration ; elles
indiquent la cible, les droits requis, les vérifications et les effets de retrait.
Les notes personnelles et la préparation de présentation ne font pas partie de
la documentation technique versionnée.
