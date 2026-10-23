# GitFlow et releases

Ce document décrit le flux de contribution et de déploiement du projet. La branche `prod` est la branche principale ; elle contient l'historique intégré et validé. Une fusion dans `prod` ne déploie pas l'application.

## Branches et pull requests

- Chaque contribution part du dernier commit de `prod` dans une branche courte nommée `feature/<sujet>` (par exemple `feature/discord-draw`). Pour une correction, utiliser `fix/<sujet>`.
- Ouvrir une pull request vers `prod`. Le contrôle `CI result` doit réussir avant sa fusion. Une review est recommandée, mais le ruleset actuel ne requiert aucune approbation (`required_approving_review_count: 0`).
- Supprimer la branche de travail après la fusion.
- Ne pas pousser directement sur `prod` ni réécrire son historique. Le ruleset GitHub impose une PR, le contrôle `CI result` et des commits signés. Une review est recommandée, mais aucune approbation n'est actuellement configurée comme obligatoire.

## Releases et déploiements

Les changements peuvent être fusionnés séparément dans `prod`, puis regroupés dans une release lorsque l'équipe décide de déployer. Le tag de release désigne le commit exact qui sera déployé.

### Comportement actuellement déployé

1. Vérifier que le commit de release est sur `prod` et que la CI est verte.
2. Créer **manuellement** un tag au format SemVer, par exemple `v1.2.0`, puis le pousser.
3. Le push du tag `v*` déclenche automatiquement `deploy.yml` : contrôles, déploiement sur `dev`, puis déploiement sur `prd` après approbation de l'environnement GitHub `prd`.
4. Le lancement manuel de `deploy.yml` (`workflow_dispatch`) exécute les contrôles et applique sur `dev` seulement. Il ne sélectionne pas un tag particulier.

Le job de production vérifie que le commit déployé est présent dans `prod`. Le workflow actuel ne vérifie pas que le tag est signé.

### Décision cible de l'équipe

L'équipe souhaite garder le contrôle du moment du déploiement et pouvoir regrouper plusieurs fonctionnalités : le push d'un tag ne devrait donc pas déployer automatiquement. Le déploiement devrait être lancé manuellement pour le tag choisi, d'abord sur `dev`, puis séparément sur `prd` après vérification. **Ce comportement cible n'est pas encore implémenté** : il faudra adapter `deploy.yml` et maintenir `docs/ci.md` en cohérence (CI-03).

La convention cible est d'utiliser des tags annotés et signés, par exemple `git tag -s -a v1.2.0 -m "Release v1.2.0" <commit>`. Le tag `v1.0.0` actuellement présent est léger et non signé. Une fois une release publiée, ne pas déplacer ni réutiliser son tag ; pour corriger une release, créer un nouveau commit et un nouveau numéro de version.

## Conventions

- Branches : `feature/<sujet>` pour une fonctionnalité, `fix/<sujet>` pour une correction. Utiliser des noms courts, en minuscules, séparés par des tirets.
- Commits : suivre [Conventional Commits](https://www.conventionalcommits.org/), par exemple `feat: add pixel drawing command` ou `fix: reject invalid colors` (`feat` est le type de commit, tandis que `feature/` est le préfixe des branches).
- Versions : suivre [SemVer](https://semver.org/) sous la forme `vMAJOR.MINOR.PATCH`. Le choix du numéro de version est fait au moment de préparer la release.
- Signer les commits et les tags ; la clé publique de signature doit être enregistrée sur GitHub.

## Événements et contrôles CI/CD

| Job / contrôle | Événement | Référence | Résultat attendu |
| --- | --- | --- | --- |
| CI de pull request | Ouverture, mise à jour ou réouverture d'une PR | Branche source vers `prod` | Formatage, validation, tests et plans Terraform dev/prd ; le ruleset exige le contrôle `CI result` |
| Déploiement dev (actuel) | Push d'un tag `v*` | Le commit du tag | Contrôles puis apply sur `dev` |
| Déploiement prd (actuel) | Après l'apply dev et approbation de l'environnement `prd` | Le même workflow de tag | Apply sur `prd`, seulement si le commit du tag appartient à `prod` |
| Déploiement manuel (actuel) | `workflow_dispatch` de `deploy.yml` | Référence choisie pour le lancement, pas un tag sélectionné | Contrôles puis apply sur `dev` uniquement |
| Déploiement cible | Lancement manuel pour un tag, puis confirmation séparée | Tag choisi, identique pour dev et prd | À implémenter dans CI-03 ; ne pas confondre avec le comportement actuel |
