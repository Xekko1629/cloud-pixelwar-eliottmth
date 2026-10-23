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

## Quota de vCPU

Le quota `CPUS_ALL_REGIONS` est de **12 vCPU** sur les deux projets (vérifié le 23/10 dans *IAM et administration > Quotas*).

En prd, au maximum :

| Pool | Machine | vCPU |
| --- | --- | --- |
| `system` | 1 × `e2-medium` | 2 |
| `runners` | 0 à 3 × `e2-standard-2` | 0 à 6 |
| **Total** | | **8** |

Le cluster tient dans le quota avec de la marge. Cloud Run ne compte pas dans ce quota. Pour une démo d'autoscaling plus large (`max_node_count` au-delà de 5), il faudra demander une hausse du quota, ce qui demande souvent un compte payant.

## Estimation du coût mensuel

Prix publics de `europe-west1`, en dollars et arrondis. La facture est en euros, à un taux proche. Les postes à usage variable sont estimés pour la charge d'un projet d'école.

### prd

| Poste | Hypothèse | ≈ $ / mois |
| --- | --- | --- |
| Frais de gestion GKE | 1 cluster zonal, couvert par le free tier (un seul par compte de facturation) | 0 |
| Nœud `system` | 1 `e2-medium` spot, 24 h/24 | 8 à 11 |
| Disques des nœuds | `pd-balanced` de 100 Go par nœud (valeur par défaut de GKE), dont 1 permanent | 11 à 15 |
| IP externes des nœuds | 1 IPv4 permanente, plus une par nœud runner allumé | 2 à 4 |
| Nœuds `runners` | `e2-standard-2` à la demande, environ 40 h de CI et de démo | 3 |
| Cloud Run `min_instances` | 1 instance minimale inactive, 1 vCPU / 512 Mio | ≈ 10 |
| Cloud NAT | aucun aujourd'hui (les nœuds ont des IP publiques) ; avec des nœuds privés : 1 à 2 $ + 0,045 $/Go traité | 0 |
| Managed Prometheus, métriques personnalisées | métriques système GKE gratuites ; 0,06 $ par million d'échantillons au-delà | 0 à 5 |
| Firestore, Pub/Sub, Hosting, Logging, API Gateway | dans le free tier pour cette charge | ≈ 0 |
| **Total** | | **≈ 35 à 50** |

### dev

Pas de cluster (`enable_cluster = false`) et pas d'instance minimale : seuls les services serverless consomment, dans le free tier. **≈ 0 à 5 $ / mois.**

Si un cluster est un jour créé en dev, ses frais de gestion ne sont plus couverts par le free tier : 0,10 $/h, soit **≈ 73 $ / mois** de plus, nœuds non compris.

### Jusqu'au 13/12

Du 23/10 au 13/12, il reste environ 1,7 mois : **≈ 60 à 95 $** pour les deux environnements. Le crédit restant est affiché dans *Facturation > Crédits*. Il doit couvrir ce montant avec de la marge, et les budgets (20 EUR par projet) préviennent si la dépense dérape. L'estimation de prd dépasse 20 EUR : ses alertes à 90 % et 100 % arriveront donc chaque mois, ce qui est normal.

### Économies possibles

- Réduire le disque des nœuds GKE (`disk_size_gb = 30` dans les deux pools) : environ −8 $ par disque et par mois. Changer ce paramètre recrée les pools de nœuds.
- Détruire le cluster prd en dehors des périodes de travail (`destroy.yml`). Ce sont le nœud `system` et son disque qui coûtent le plus.
- Garder `min_instances = 0` en dev.
