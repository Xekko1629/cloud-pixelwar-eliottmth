# Projets GCP et coûts

## Projets et facturation

| Environnement | Projet | Numéro |
| --- | --- | --- |
| dev | `cloud-pixelwar-dev` | 604633290708 |
| prd | `cloud-pixelwar-prod` | 241409932843 |

Les deux projets sont liés au compte de facturation `0111A1-F02A73-B2E667`, qui porte les crédits gratuits.

## Budgets

Chaque projet a un budget mensuel, créé par le stack `infra/iam` (`budget.tf`) :

| Projet | Montant | Alertes |
| --- | --- | --- |
| dev | 20 EUR | 50 %, 90 %, 100 % |
| prd | 20 EUR | 50 %, 90 %, 100 % |

Les alertes partent par e-mail aux administrateurs et aux utilisateurs du compte de facturation. Les adresses ne sont donc pas dans le dépôt, qui est public. Pour que les 3 membres les reçoivent, chacun doit avoir le rôle *Billing Account User* (`roles/billing.user`) ou *Billing Account Administrator* sur le compte de facturation : *Facturation > Gestion des comptes > Ajouter un compte principal*.

Créer ou modifier un budget demande aussi des droits sur le compte de facturation (`billing.budgets.*`, par exemple *Billing Account Costs Manager*). `infra/iam` n'est jamais appliqué par la CI : la personne qui l'applique doit avoir ce rôle.

Un budget ne coupe rien : il ne fait qu'envoyer des alertes. Sur un compte payant, c'est le seul garde-fou.

### Vérifier qu'une alerte arrive

Un budget n'a pas de bouton « envoyer un test ». Pour vérifier la chaîne d'envoi :

1. Dans *Facturation > Budgets et alertes*, créer à la main un budget temporaire sur le projet prd, d'un montant inférieur à la dépense déjà faite ce mois-ci (par exemple 1 EUR), avec une alerte à 50 %.
2. Attendre l'e-mail : la dépense est évaluée plusieurs fois par jour, l'alerte arrive en général en quelques heures.
3. Vérifier que les 3 membres l'ont reçue, puis supprimer ce budget temporaire.

## Région : `europe-west1` (Belgique)

Toutes les ressources sont dans `europe-west1`, et le cluster GKE dans la zone `europe-west1-b`.

- **Coût** : `europe-west1` fait partie des régions européennes les moins chères (palier de prix 1 pour Cloud Run, mêmes tarifs Compute Engine que `us-central1` à quelques pourcents près). Paris (`europe-west9`) et Francfort (`europe-west3`) coûtent plus cher.
- **Latence** : 10 à 20 ms depuis la France. Firebase Hosting passe de toute façon par un CDN.
- **Empreinte carbone** : la région est marquée *Faible émission de CO2* dans la console (électricité décarbonée à environ 80 % selon Google).
- **Services** : API Gateway n'existe que dans quelques régions, dont `europe-west1` ([liste des régions](https://cloud.google.com/api-gateway/docs/deployment-model#choosing_a_gcp_region)). `europe-west9` et `europe-west3` n'en font pas partie. Cloud Run, Pub/Sub, GKE et Firestore (`eur3` ou `europe-west1`) y sont aussi disponibles.

## Quotas et plafonds du cluster

Deux quotas de prd limitent la taille du cluster (vérifiés le 06/11, visibles dans *IAM et administration > Quotas*) :

- `CPUS_ALL_REGIONS` : **16 vCPU** ;
- `SSD_TOTAL_GB` dans `europe-west1` : **300 Go**. Les disques `pd-balanced` des nœuds comptent dans ce quota.

Les plafonds de Terraform sont choisis pour que le cluster tienne dans ces quotas même au maximum, au lieu de laisser le quota bloquer l'autoscaling avec des erreurs `QUOTA_EXCEEDED` :

| Pool | Machine | Nœuds | vCPU comptés dans le quota | Disque (30 Go par nœud) |
| --- | --- | --- | --- | --- |
| `system` | `e2-medium` spot | 1 à 2 | 1 à 2 | 30 à 60 Go |
| `runners` | `e2-standard-2` | 0 à 6 | 0 à 12 | 0 à 180 Go |
| **Total** | | **1 à 8** | **1 à 14** | **30 à 240 Go** |

- Un `e2-medium` est une machine à cœur partagé : il ne compte que pour 1 vCPU dans le quota, même s'il expose 2 vCPU.
- `max_node_count = 6` sur le pool `runners` (`infra/foundation/cluster.tf`) : 6 × 2 vCPU + 2 vCPU du pool `system` = 14 vCPU sur 16. Les 2 vCPU restants absorbent le nœud supplémentaire que GKE crée pendant une mise à niveau d'un pool.
- `max_runners = 6` (`infra/runners/variables.tf`) : un pod runner demande 1 vCPU et 2 Gio, donc un seul runner tient sur un `e2-standard-2`. Le nombre de runners et le nombre de nœuds ont ainsi le même plafond.
- Le pool `runners` redescend à 0 nœud quand aucun job ne tourne.

Cloud Run ne compte pas dans le quota de vCPU. Pour aller au-delà de 6 runners, il faut d'abord demander une hausse du quota de vCPU (et du quota SSD au-delà de 10 nœuds), puis relever `max_node_count` et `max_runners` ensemble.

## Estimation du coût mensuel

Prix publics de `europe-west1`, en dollars et arrondis. La facture est en euros, à un taux proche. Les postes à usage variable sont estimés pour la charge d'un projet d'école.

### prd

| Poste | Hypothèse | ≈ $ / mois |
| --- | --- | --- |
| Frais de gestion GKE | 1 cluster zonal, couvert par le free tier (un seul par compte de facturation) | 0 |
| Nœuds `system` | 1 `e2-medium` spot 24 h/24, parfois 2 | 8 à 15 |
| Disques des nœuds | `pd-balanced` de 30 Go par nœud (environ 3,5 $ par disque et par mois), dont 1 permanent | 4 à 6 |
| IP externes des nœuds | 1 IPv4 permanente, plus une par nœud runner allumé | 2 à 4 |
| Nœuds `runners` | `e2-standard-2` à la demande, environ 80 h-nœud de CI et de démo par mois | 6 |
| Cloud Run `min_instances` | 1 instance minimale inactive, 1 vCPU / 512 Mio | ≈ 10 |
| Cloud NAT | aucun aujourd'hui (les nœuds ont des IP publiques) ; avec des nœuds privés : 1 à 2 $ + 0,045 $/Go traité | 0 |
| Managed Prometheus, métriques personnalisées | métriques système GKE gratuites ; 0,06 $ par million d'échantillons au-delà | 0 à 5 |
| Firestore, Pub/Sub, Hosting, Logging, API Gateway | dans le free tier pour cette charge | ≈ 0 |
| **Total** | | **≈ 30 à 45** |

### dev

Pas de cluster (`enable_cluster = false`) et pas d'instance minimale : seuls les services serverless consomment, dans le free tier. **≈ 0 à 5 $ / mois.**

Si un cluster est un jour créé en dev, ses frais de gestion ne sont plus couverts par le free tier : 0,10 $/h, soit **≈ 73 $ / mois** de plus, nœuds non compris.

### Jusqu'au 13/12

Du 06/11 au 13/12, il reste environ 1,2 mois : **≈ 35 à 60 $** pour les deux environnements. Le crédit restant est affiché dans *Facturation > Crédits*. Il doit couvrir ce montant avec de la marge, et les budgets (20 EUR par projet) préviennent si la dépense dérape. L'estimation de prd dépasse 20 EUR : ses alertes à 90 % et 100 % arriveront donc chaque mois, ce qui est normal.

Au pire, si les 8 nœuds tournaient en continu (runners bloqués à 6), le cluster coûterait environ 0,45 $/h, soit environ 11 $ par jour : l'alerte à 50 % du budget prd arriverait en un jour.

### Économies possibles

- Détruire le cluster prd en dehors des périodes de travail (`destroy.yml`). Ce sont le nœud `system` et son disque qui coûtent le plus.
- Garder `min_instances = 0` en dev.
