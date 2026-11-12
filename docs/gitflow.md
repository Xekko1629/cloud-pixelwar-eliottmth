# Contribution et releases

## Branches et pull requests

`prod` est la branche principale. Créer une branche courte `feature/<sujet>` ou
`fix/<sujet>` depuis sa version intégrée, puis ouvrir une PR vers `prod`.
Une fusion ne déploie pas l'application.

- Utiliser des commits signés et les Conventional Commits : `feat: …`, `fix: …`,
  `docs: …`. Le type de commit `feat` ne change pas le préfixe `feature/` des branches.
- Faire réussir `CI result`, lire les plans et obtenir une review avant fusion.
- Ne pas pousser directement sur `prod`, ne pas réécrire son historique et ne
  pas déplacer un tag publié. Supprimer la branche après intégration.

Ces règles de contribution ne décrivent pas à elles seules les protections
automatisées du dépôt. Vérifier les rulesets, contrôles requis, approbations et
exceptions administrateur dans les paramètres GitHub. Un besoin de modification
de ces règles se suit dans une issue, pas comme un workflow hypothétique ici.

## Déploiement dev manuel

Le lancement `workflow_dispatch` de `deploy.yml` applique dev seulement. Choisir
la référence approuvée dans **Actions → Deploy → Run workflow** ; utiliser
`runner=ubuntu-latest` pour les contrôles si les runners auto-hébergés ne doivent
pas être sollicités. Ce lancement n'applique ni IAM ni les accès humains.

Les prérequis, ressources touchées et vérifications sont décrits dans le
[guide de déploiement](deployment.md). Ne pas utiliser un tag de release pour
un essai limité à dev.

## Release dev puis prd

1. Choisir un commit intégré à `prod`, vérifier sa CI et les plans, puis faire
   valider la release et ses effets GCP.
2. Choisir un nouveau numéro [SemVer](https://semver.org/), `vMAJOR.MINOR.PATCH`.
3. Créer un tag annoté et signé sur le commit choisi, puis le pousser :

   ```sh
   VERSION='vX.Y.Z'
   COMMIT='SHA_DU_COMMIT_APPROUVE'
   git tag -s -a "$VERSION" -m "Release $VERSION" "$COMMIT"
   git push origin "$VERSION"
   ```

4. **Le push déclenche automatiquement `Deploy`** : contrôles, dev, puis prd
   après les dépendances dev et les approbations GitHub configurées.
5. Vérifier les ressources et intégrations après chaque déploiement. Pour corriger
   une release, produire un nouveau commit et un nouveau numéro ; ne pas réutiliser
   le tag.

Les commandes contiennent des paramètres à remplacer, pas un numéro de version
à copier tel quel. La signature nécessite une clé publique enregistrée sur GitHub.
Le job d'apply prd contrôle l'appartenance du commit à `origin/prod`, mais le
workflow ne vérifie pas cryptographiquement le tag. Convention de signature,
protection de branche et conditions du workflow sont trois contrôles distincts.

## Références

- [Fonctionnement de la CI/CD](ci.md) : jobs, authentification et runners.
- [Installation, mise à jour et retrait](deployment.md) : procédure opérationnelle.
- [Conventional Commits](https://www.conventionalcommits.org/).
