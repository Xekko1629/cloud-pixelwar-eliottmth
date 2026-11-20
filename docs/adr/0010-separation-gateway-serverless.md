# ADR-0010 · Séparer les cycles de vie Gateway et fonctions

- **Statut** : Proposé
- **Date** : 2026-11-13
- **Tickets** : SRV-04a (#32), SRV-09 (#39), SRV-02 (#30), DOC-01 (#86).
- **Références** : [lifecycle Terraform](https://developer.hashicorp.com/terraform/language/meta-arguments/lifecycle#create_before_destroy-and-resource-dependencies), [refactoring des states](https://developer.hashicorp.com/terraform/language/state/refactor), [modèle API Gateway](https://cloud.google.com/api-gateway/docs/deployment-model).

## Contexte

Une configuration API Gateway est immuable. Son remplacement nécessite un nouvel
ID et `create_before_destroy`, puis la bascule de la Gateway avant suppression
de l'ancienne config. Terraform propage ce cycle de vie à toutes ses dépendances
dans le même graphe, même si elles ne déclarent pas ce lifecycle.

Une fonction à nom fixe ne peut pas être créée en double. Après une création en
échec marquée `tainted`, ou un autre remplacement forcé, la propagation impose
un ordre « créer puis supprimer » incompatible avec ce nom. Ce problème ne se
résout pas avec davantage de droits IAM, ni en imposant `false` à la fonction
tant que la dépendance existe.

## Décision proposée

1. `infra/serverless` gère les sources, fonctions, identités runtime et intégrations
   de workers ; il exporte les proxies via `gateway_contract` versionné.
2. `infra/gateway` possède un state distinct et consomme ce contrat après un apply
   serverless réussi. Il gère Gateway, configurations et identité d'invocation
   des proxies ; le module réutilisable existant est conservé.
3. Le contrat doit correspondre au projet, à l'environnement et à la région. Il
   ne contient pas de valeur secrète. Un contrat absent ou incompatible bloque
   l'opération ; un contrat vide valide signifie qu'aucun proxy n'est publié.
4. La CI applique les fonctions avant Gateway et détruit Gateway avant les fonctions.
   Un plan PR lit le dernier contrat appliqué, pas les valeurs futures d'un autre
   plan ; l'absence initiale de contrat est signalée comme plan Gateway différé.
5. Toute installation avec une Gateway déjà gérée par serverless exige une
   migration d'ownership approuvée, avec `removed`/`import`, pas une recréation
   implicite. Le workflow standard bloque tant que ce transfert n'est pas fait.

## Options écartées

- Retirer simplement `create_before_destroy` de la config : compromet la bascule
  depuis une config immuable encore utilisée.
- Ajouter `create_before_destroy = false` à la fonction : ne neutralise pas la
  propagation depuis une dépendance aval.
- Supprimer manuellement la fonction à chaque conflit : récupération ponctuelle,
  pas correction du graphe ni procédure normale de déploiement.
- Versionner systématiquement les noms physiques des fonctions : change les
  identités des services, URLs et règles d'exploitation alors que le besoin porte
  sur l'indépendance des cycles de vie.

## Conséquences

- Le renouvellement des configs Gateway ne peut plus propager son lifecycle
  dans les ressources du state serverless. Les fonctions gardent leurs noms.
- Un remplacement de fonction reste destructif et peut causer une interruption :
  cette séparation ne promet pas un déploiement applicatif sans interruption.
- Il faut un contrat, un state et une étape CI supplémentaires, ainsi qu'un ordre
  explicite de suppression et une procédure de migration pour l'existant.
- `terraform_remote_state` exige la lecture du snapshot complet, malgré une API
  limitée aux outputs. Réexaminer les droits si des données sensibles sont ajoutées
  au state source ; préférer alors une publication séparée du contrat.
- Les verrous par stack n'empêchent pas deux orchestrations concurrentes ; ne pas
  exécuter plusieurs releases ou un deploy/destroy du même environnement en parallèle.
