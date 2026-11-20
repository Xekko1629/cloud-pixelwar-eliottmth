# Cloud Pixelwar

Application de dessin collaboratif pilotée depuis Discord et une interface web.
Le backend utilise des Cloud Run functions HTTP, avec API Gateway pour les
proxies et Pub/Sub en push OIDC pour les traitements événementiels.

L'infrastructure est décrite en Terraform. Les runners CI auto-hébergés utilisent
GKE ; les fonctions applicatives ne s'exécutent pas dans ce cluster.

## Démarrer

1. [Préparer le poste](docs/outillage.md).
2. [Installer et déployer depuis zéro](docs/deployment.md).
3. [Exécuter les tests locaux](docs/testing.md).

## Documentation

- [Index des guides](docs/README.md)
- [Architecture et frontières de sécurité](docs/architecture.md)
- [Décisions d'architecture](docs/adr/README.md)
- [Contribution et releases](docs/gitflow.md)
- [Fonctionnement de la CI/CD](docs/ci.md)

Les guides décrivent le code de la version consultée et ses procédures. Le suivi
du travail et les résultats d'exécution sont dans le
[GitHub Project](https://github.com/users/Xekko1629/projects/3), les issues, les PR
et les rapports CI. Aucun secret ni state Terraform ne doit être ajouté au dépôt.
