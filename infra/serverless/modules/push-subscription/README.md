# Module `push-subscription`

Un abonnement push Pub/Sub vers un worker privé, avec sa propre DLQ (ADR-0002, SRV-05).

| Ressource | Rôle |
| --- | --- |
| `google_pubsub_topic.dlq` | `<name>-dlq`, reçoit les messages après environ `max_delivery_attempts` échecs (5 par défaut, de 5 à 100) |
| `google_pubsub_subscription.dlq_inspect` | `<name>-dlq-inspect`, pull, pour inspecter et rejouer |
| `google_pubsub_subscription.main` | `<name>`, push OIDC vers `push_endpoint` (aussi audience), retry 10 à 60 s, 7 jours |
| `dlq_publisher`, `dlq_forwarder` | Droits de transfert de l'agent Pub/Sub, limités à cette DLQ et cet abonnement |

Le droit `roles/iam.serviceAccountTokenCreator` de l'agent Pub/Sub sur l'invoker reste
chez l'appelant : plusieurs abonnements d'un même worker partagent un invoker, et une
même attribution ne doit pas être gérée deux fois. Déclarer l'abonnement après ce
droit (`depends_on`).

`ack_deadline_seconds` doit dépasser le timeout du worker (600 s au maximum en push).
Les messages Discord contiennent le token d'interaction : restreindre les lecteurs de
la DLQ. Tests : `terraform test` dans ce dossier (mocks uniquement).
