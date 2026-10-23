# Décisions d'architecture (ADR)

Un ADR (*Architecture Decision Record*) consigne une décision d'architecture : le contexte, ce qu'on a choisi, ce qu'on a écarté et pourquoi. Chacun doit pouvoir être défendu à l'oral par n'importe quel membre de l'équipe.

## Règles

- Une décision par fichier, numérotée : `NNNN-titre-court.md`.
- Un ADR se crée ou se modifie par PR, comme le code. La review de la PR vaut validation par l'équipe.
- Un ADR accepté ne se réécrit pas. Pour changer d'avis, on écrit un nouvel ADR qui le remplace, et on passe l'ancien au statut « Remplacé par ADR-XXXX ».
- Statuts possibles : **Proposé** (en attente d'une validation, par exemple de l'encadrant), **Accepté**, **Remplacé**.

## Index

| ADR | Décision | Statut |
|---|---|---|
| [0001](0001-compute-cloud-run-typescript.md) | Compute : services Cloud Run, en TypeScript sur Node.js 24 | Accepté |
| [0002](0002-broker-pubsub-push.md) | Broker : Pub/Sub en push authentifié par OIDC | Accepté |
| [0003](0003-temps-reel-listeners-firestore.md) | Temps réel : listeners Firestore sur des deltas par région | Accepté |
| [0004](0004-lectures-directes-firestore.md) | Lectures directes de Firestore depuis le navigateur | Proposé (à valider par l'encadrant) |
| [0005](0005-identite-web-firebase-auth.md) | Identité web : OAuth2 Discord côté serveur, puis custom token Firebase | Accepté |
| [0006](0006-hebergement-frontend-firebase-hosting.md) | Hébergement du frontend : Firebase Hosting | Accepté |
| [0007](0007-modele-donnees-grille.md) | Données : grille infinie ou bornée par un admin, tuiles 64×64, régions 1024×1024, palette de 16 couleurs | Accepté |

Décision attendue ailleurs : la stratégie de build des images (FND-06c) fera l'objet de l'ADR suivant.

## Modèle

```markdown
# ADR-NNNN · Titre

- **Statut** : Proposé | Accepté | Remplacé par ADR-XXXX
- **Date** : AAAA-MM-JJ
- **Tickets** : …
- **Références** : Sujet §…, Cxx §…

## Contexte
Le problème, les contraintes du sujet et des supports.

## Décision
Ce qu'on fait, assez précisément pour que les tickets puissent s'en servir.

## Options écartées
Chaque alternative sérieuse, et pourquoi elle n'a pas été retenue.

## Conséquences
Ce que la décision apporte, ce qu'elle coûte, et ce qu'il faut surveiller.

## En soutenance
La justification en deux ou trois phrases.
```
