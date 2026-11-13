# Décisions d'architecture (ADR)

Un ADR (*Architecture Decision Record*) consigne une décision d'architecture :
contexte, contraintes techniques, choix retenu, alternatives et conséquences.

## Règles

- Une décision par fichier, numérotée : `NNNN-titre-court.md`.
- Un ADR se crée ou se modifie par PR, comme le code. La review de la PR vaut validation par l'équipe.
- Une décision acceptée ne se remplace pas par une réécriture rétroactive. Pour
  changer de choix, créer un nouvel ADR et référencer le remplacement. Une
  correction éditoriale ne doit pas modifier les garanties ou options décidées.
- Statuts possibles : **Proposé** (en attente de validation), **Accepté**, **Remplacé**.
- Dates, statuts et liens de remplacement décrivent l'historique des décisions,
  pas l'avancement des tickets. Les runbooks utilisent les décisions actives et
  le comportement du code de la version consultée.
- Rédiger la prose en français ; conserver les noms de produits, identifiants
  et commandes. Ne pas inclure de préparation orale, récit personnel ou liste
  de travaux à réaliser. Les tickets peuvent être liés sans recopier leur état.

## Index

| ADR | Décision | Statut |
|---|---|---|
| [0001](0001-compute-cloud-run-typescript.md) | Compute : services Cloud Run, en TypeScript sur Node.js 24 | Remplacé par ADR-0008 |
| [0002](0002-broker-pubsub-push.md) | Broker : Pub/Sub en push authentifié par OIDC | Accepté |
| [0003](0003-temps-reel-listeners-firestore.md) | Temps réel : listeners Firestore sur des deltas par région | Accepté |
| [0004](0004-lectures-directes-firestore.md) | Lectures directes de Firestore depuis le navigateur | Proposé |
| [0005](0005-identite-web-firebase-auth.md) | Identité web : OAuth2 Discord côté serveur, puis custom token Firebase | Accepté |
| [0006](0006-hebergement-frontend-firebase-hosting.md) | Hébergement du frontend : Firebase Hosting | Accepté |
| [0007](0007-modele-donnees-grille.md) | Données : grille infinie ou bornée par un admin, tuiles 64×64, régions 1024×1024, palette de 16 couleurs | Accepté |
| [0008](0008-compute-cloud-run-functions.md) | Compute : Cloud Run functions déployées depuis une archive de sources identifiée par SHA-256 | Accepté, artefact de release remplacé par ADR-0009 |
| [0009](0009-sources-fonctions-terraform.md) | Sources des fonctions : construites par la CI, zippées et téléversées par Terraform | Accepté |
| [0010](0010-separation-gateway-serverless.md) | Séparation des cycles de vie Gateway et fonctions, avec contrat d'outputs | Proposé |

Le build des sources est décrit par l'ADR-0009. Pour les procédures exécutables,
consulter [Installation et déploiement](../deployment.md).

## Modèle

```markdown
# ADR-NNNN · Titre

- **Statut** : Proposé | Accepté | Remplacé par ADR-XXXX
- **Date** : AAAA-MM-JJ
- **Tickets** : …
- **Références** : spécifications, documentation technique…

## Contexte
Le problème et ses contraintes techniques.

## Décision
Le choix retenu, ses limites et les garanties attendues.

## Options écartées
Chaque alternative sérieuse, et pourquoi elle n'a pas été retenue.

## Conséquences
Ce que la décision apporte, ce qu'elle coûte, et ce qu'il faut surveiller.

```
