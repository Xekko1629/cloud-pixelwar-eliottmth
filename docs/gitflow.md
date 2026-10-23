# GitFlow et releases

Ce document décrit le flux de contribution et de déploiement du projet. La branche `prod` est la branche principale ; elle contient l'historique intégré et validé. Une fusion dans `prod` ne déploie pas l'application.

## Branches et pull requests

- Chaque contribution part du dernier commit de `prod` dans une branche courte nommée `feat/<sujet>` (par exemple `feat/discord-draw`). Pour une correction, utiliser `fix/<sujet>`.
- Ouvrir une pull request vers `prod`. La PR doit être relue et tous les contrôles CI requis doivent réussir avant sa fusion.
- Supprimer la branche de travail après la fusion.
- Ne pas pousser directement sur `prod` ni réécrire son historique. Protéger la branche dans GitHub : PR obligatoire, review obligatoire et contrôles CI requis. Les commits doivent être signés et vérifiés.

## Releases et déploiements

Les changements peuvent être fusionnés séparément dans `prod`, puis regroupés dans une release lorsque l'équipe décide de déployer. Le tag de release désigne le commit exact qui sera déployé.

1. Vérifier que le commit de release est sur `prod` et que la CI est verte.
2. Créer **manuellement** un tag annoté et signé au format SemVer, par exemple `v1.2.0` : `git tag -s -a v1.2.0 -m "Release v1.2.0" <commit>`.
3. Pousser le tag : `git push origin v1.2.0`.
4. Un membre autorisé lance manuellement le job de déploiement pour ce tag. Le job déploie le commit pointé par le tag, et non la tête courante de `prod`.
5. Déployer d'abord sur `dev`, vérifier le résultat, puis lancer/confirmer séparément le déploiement sur `prd`.

Le push du tag ne lance pas automatiquement un déploiement. Le tag sert de référence immuable pour choisir et identifier la release ; le lancement du déploiement reste une décision humaine. Les détails d'implémentation des jobs et de leurs déclencheurs sont définis dans les workflows CI/CD.

Un tag publié ne doit pas être déplacé ni réutilisé. Si une release doit être corrigée, créer un nouveau commit et un nouveau numéro de version.

## Conventions

- Branches : `feat/<sujet>` pour une fonctionnalité, `fix/<sujet>` pour une correction. Utiliser des noms courts, en minuscules, séparés par des tirets.
- Commits : suivre [Conventional Commits](https://www.conventionalcommits.org/), par exemple `feat: add pixel drawing command` ou `fix: reject invalid colors`.
- Versions : suivre [SemVer](https://semver.org/) sous la forme `vMAJOR.MINOR.PATCH`. Le choix du numéro de version est fait au moment de préparer la release.
- Signer les commits et les tags ; la clé publique de signature doit être enregistrée sur GitHub.

## Événements et contrôles CI/CD

| Job / contrôle | Événement | Référence | Résultat attendu |
| --- | --- | --- | --- |
| CI de pull request | Ouverture, mise à jour ou réouverture d'une PR | Branche source vers `prod` | Formatage, validation et contrôles de test requis avant fusion (voir CI-02) |
| Déploiement dev | Lancement manuel par un membre autorisé | Tag SemVer signé sélectionné | Déployer exactement le commit du tag sur `dev` |
| Déploiement prd | Lancement manuel distinct après validation de dev | Même tag que dev | Déployer exactement le même commit sur `prd` |
