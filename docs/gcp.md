# Configuration GCP et maîtrise des coûts

## Environnements et sources de configuration

| Environnement | Projet de référence | Configuration |
| --- | --- | --- |
| dev | `cloud-pixelwar-dev` | `infra/*/dev.tfvars`, `backends/dev.hcl` |
| prd | `cloud-pixelwar-prod` | `infra/*/prd.tfvars`, `backends/prd.hcl` |

Le compte de facturation et les buckets de state sont référencés par les
variables IAM. Leur nom peut être distinct de l'ID du projet. Pour installer
d'autres projets, adapter l'ensemble des configurations avant les opérations,
selon le [guide depuis zéro](deployment.md).

Les propriétés versionnées décrivent la configuration demandée, pas l'inventaire
GCP effectif. Vérifier celui-ci avec le plan, les APIs et la console avant de
calculer les coûts ou de supprimer des ressources.

## Budgets et alertes

`infra/iam/budget.tf` déclare un budget par projet, filtré sur son numéro GCP.
`budget_amount`, `budget_currency` et `budget_alert_thresholds` définissent
montant, devise et seuils. Vérifier les destinataires dans la configuration
Cloud Billing et leur réception effective ; ne pas supposer que tous les membres
du dépôt reçoivent les emails.

Créer/modifier un budget demande des permissions sur le compte de facturation,
en plus des droits projet. IAM est appliqué manuellement par une identité
autorisée à gérer ces budgets.

**Un budget n'arrête pas la consommation.** Les plafonds d'instances, de nœuds,
de runners et les règles de conservation constituent d'autres contrôles, mais
ne garantissent pas à eux seuls un plafond absolu de facture.

Pour tester une alerte, utiliser un budget de test approuvé avec seuil adapté à
une dépense réelle, attendre l'évaluation de facturation et vérifier la réception.
Retirer le budget de test après vérification. Cette opération modifie Cloud
Billing et doit être distinguée d'une consultation des coûts.

## Régions et disponibilité des services

Les stacks utilisent la variable `region` ; la région par défaut est
`europe-west1`. Le cluster utilise la zone configurée par foundation. Les
ressources globales et buckets peuvent avoir une autre portée ou localisation.

Avant de changer de région, vérifier la disponibilité d'API Gateway, Cloud Run
functions, Artifact Registry, GKE et des stockages utilisés, ainsi que les quotas,
latences, prix et éventuels remplacements Terraform. Les localisations d'une base
ou d'un bucket ne se modifient pas comme un simple paramètre de runtime.

- [Régions API Gateway](https://cloud.google.com/api-gateway/docs/deployment-model#choosing_a_gcp_region)
- [Localisations Cloud Run](https://cloud.google.com/run/docs/locations)
- [Caractéristiques carbone des régions](https://cloud.google.com/sustainability/region-carbon)

## Quotas et plafonds

Avant un premier déploiement, une montée en charge ou une modification de pool :

1. Lire les quotas accordés au projet dans **IAM et administration → Quotas**.
   Vérifier les métriques globales et régionales ; une limite relevée dans un
   autre projet ne s'applique pas automatiquement.
2. Additionner la consommation des machines système/runners et des autres usages,
   en tenant compte de la méthode de comptage des types de machines.
3. Inclure les disques de tous les nœuds et la capacité de mise à niveau/surge,
   pas seulement le nombre nominal d'instances.
4. Comparer avec `max_node_count`, les limites de pools, `maxRunners` et les
   demandes CPU/mémoire des pods dans `infra/foundation` et `infra/runners`.
5. Vérifier séparément les quotas Cloud Run functions, Cloud Build, Pub/Sub et
   stockage ; ne pas les confondre avec les seuls quotas Compute Engine.

Exemples de consultation sans modification, après définition de `PROJECT_ID`
et `REGION` :

```sh
gcloud compute project-info describe --project="$PROJECT_ID" --format='json(quotas)'
gcloud compute regions describe "$REGION" --project="$PROJECT_ID" --format='json(quotas)'
```

Une erreur `QUOTA_EXCEEDED` exige un diagnostic de la métrique et du périmètre.
Demander une hausse approuvée ou réduire la configuration ; ne pas augmenter
les plafonds de nœuds/runners sans vérifier quota et budget ensemble.

## Estimer et contrôler les coûts

Calculer par environnement et par période, avec hypothèses explicites et tarifs
publics consultés à la date du calcul. Conserver les simulations datées dans les
rapports d'exploitation ou tickets ; recalculer avant une modification de charge.

| Poste | Paramètres à prendre en compte |
| --- | --- |
| GKE | Gestion du cluster, éligibilité au free tier, nœuds système et heures-nœuds runners |
| Compute/réseau | Disques, IPv4, trafic sortant, NAT/équilibreurs si configurés, capacité de mise à niveau |
| Fonctions | CPU, mémoire, durée, nombre de requêtes, instances minimales/maximales et builds |
| Données | Lectures/écritures Firestore, Pub/Sub, stockage des objets et versions non courantes |
| Artefacts et secrets | Registre, archives, rétention, versions de secrets et accès |
| Observabilité | Ingestion/rétention de logs, traces, métriques personnalisées et échantillons Prometheus |
| Hébergement/API | Trafic Hosting, requêtes Gateway et services auxiliaires utilisés |

Comparer les estimations aux dépenses réelles dans **Facturation → Rapports**,
en distinguant tarifs, crédits et quotas gratuits. Un crédit disponible n'est
pas un mécanisme technique de limitation de charge.

Pour limiter les coûts, vérifier `min_instances`, plafonds de pools/runners,
échantillonnage, rétentions et ressources conservées. La suppression des workloads
via [Destroy](deployment.md#suppression) conserve IAM, accès et bootstrap :
archives versionnées, secrets et states peuvent continuer à être facturés.
