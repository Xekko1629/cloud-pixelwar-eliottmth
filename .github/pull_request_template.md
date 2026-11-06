## Description

<!-- Ce que change la PR et pourquoi. -->

## Tickets liés

<!-- Une ligne par ticket, par exemple : Closes #5 -->
Closes #

## Comment vérifier

<!-- Commandes ou étapes pour vérifier le changement (plan Terraform, test, capture...). -->

## Definition of Done

- [ ] Branche `feature/*` ou `fix/*` partie de `prod`, commits signés (*Verified*) au format Conventional Commits
- [ ] CI verte, relue par au moins un autre membre
- [ ] Logique métier couverte par des tests unitaires lancés en CI
- [ ] Ressources cloud créées par Terraform ou Helm et déployées par la pipeline (sauf stacks `bootstrap` et `access`)
- [ ] Un service account par fonction ou service, avec seulement les rôles nécessaires
- [ ] Observabilité : logs JSON avec `correlation_id`, métriques visibles, alerte si le composant est critique
- [ ] Aucun secret dans le dépôt, les `tfvars` ou le state Terraform
- [ ] Si l'architecture change : `docs/architecture.md` et la doc concernée mis à jour
- [ ] `destroy` supprime les ressources sans action manuelle

<!-- Cocher ou barrer (~~texte~~) les points qui ne s'appliquent pas, avec une courte raison. -->
