# ADR-0002 · Broker : Pub/Sub en push authentifié par OIDC

- **Statut** : Accepté
- **Date** : 2026-10-23
- **Tickets** : ARCH-01 (#26). Utilisé par ARCH-03, SRV-05, SRV-07, SRV-08, DATA-05c, BOT-07b.
- **Références** : Sujet §3.1 · C06 §3, §7 · C07 §2

## Contexte

- Tout le travail réel passe par un broker. Les proxies publient un événement puis répondent tout de suite ; les workers consomment et font le travail (§3.1, C06 §7).
- C06 §3.4 demande des DLQ, une rétention suffisante et des consommateurs idempotents.
- Certains événements ne viennent pas d'un proxy :
  - la fin d'écriture d'un snapshot dans le bucket déclenche son notifier (C07 §2) ;
  - la régénération de la vue éloignée se déclenche régulièrement (DATA-05c).
- Les workers sont des services Cloud Run privés (ADR-0001).

## Décision

### Topics et abonnements

- **Pub/Sub**, avec un topic par type d'événement (catalogue dans ARCH-03) et un abonnement par consommateur.
- Le fan-out se fait en mettant plusieurs abonnements sur le même topic. Par exemple, `pixel-processed` est consommé à la fois par le `discord-notifier` et par le marquage des régions de la vue éloignée.

### Livraison en push avec un token OIDC

- Chaque abonnement **pousse** les messages vers l'URL `run.app` de son worker, avec un **token OIDC**.
- Pub/Sub signe ce token au nom d'un service account d'invocation dédié au worker, qui a `run.invoker` sur ce worker et sur rien d'autre.
- Cloud Run vérifie le token avant d'exécuter le code : le worker n'a aucune logique d'authentification à écrire.
- Droits nécessaires (documentation Pub/Sub) :
  - le principal qui crée l'abonnement (le deployer) a `iam.serviceAccounts.actAs` sur le service account d'invocation ;
  - l'agent de service Pub/Sub a `iam.serviceAccountTokenCreator` sur ce service account.

### Contrat entre Pub/Sub et un worker

| Le worker… | Effet |
|---|---|
| répond 2xx | Message acquitté. |
| rejette pour une raison métier attendue (quota dépassé, pause, coordonnées invalides) | C'est un traitement réussi : il répond 2xx et publie un événement de rejet (`pixel-rejected`). |
| échoue pour une raison technique (Firestore indisponible, bug) | Il répond une erreur, et Pub/Sub retente avec un backoff exponentiel. |
| échoue 5 fois de suite | Le message part dans la DLQ de l'abonnement (SRV-05), qui déclenche une alerte dès qu'elle n'est plus vide. |

- La livraison est « au moins une fois », sans ordre garanti. Chaque worker est donc idempotent : déduplication par `event_id`, et règle *last-write-wins* sur `occurred_at` (DATA-02).
- Le `correlation_id` et le contexte de trace (`traceparent`) voyagent dans les attributs du message (SRV-08).

### Sources qui ne sont pas des proxies

Elles passent aussi par Pub/Sub, pour n'avoir qu'un seul mécanisme de livraison, donc une seule façon de configurer les retries, les DLQ et les alertes :

- **Snapshot écrit** : une notification Cloud Storage `OBJECT_FINALIZE` (`google_storage_notification`) publie dans un topic, qui pousse vers le `snapshot-notifier`. L'agent de service Cloud Storage a besoin de `pubsub.publisher` sur ce topic.
- **Vue éloignée** : Cloud Scheduler publie dans un topic à intervalle régulier, qui pousse vers l'`overview-worker`.

## Options écartées

| Option | Pourquoi elle est écartée |
|---|---|
| Eventarc (déclencheurs Pub/Sub ou Cloud Storage) | Eventarc crée et gère lui-même l'abonnement Pub/Sub sous-jacent. La ressource `google_eventarc_trigger` ne permet de configurer ni DLQ ni délai d'acquittement, et son `retry_policy.max_attempts` n'accepte que la valeur 1 (documentation du provider). On perdrait la DLQ exigée par C06 §3.4, ou il faudrait modifier à la main, hors de Terraform, un abonnement que gère Eventarc. Il impose aussi le format CloudEvents, dont on n'a pas besoin. |
| Pub/Sub en pull | Le worker doit tourner en continu pour tirer les messages : on perd le scale à zéro, et le scaling de Cloud Run piloté par les requêtes. |
| Cloud Tasks | File point à point, sans fan-out. Adaptée à des appels HTTP différés, pas à un bus d'événements avec plusieurs consommateurs. |
| Un service qui en appelle un autre directement | Couplage synchrone : c'est précisément ce que le modèle événementiel interdit (C06 §7, définition d'« Event »). |

## Conséquences

**Ce qu'on y gagne**

- Le scaling vient tout seul : Cloud Run ajoute des instances selon le débit des pushs, et la file absorbe les pics. Le `max_instances` du `draw-worker` protège Firestore (DRAW-02).
- Les métriques natives de Pub/Sub alimentent directement la démo et les alertes : messages non acquittés, âge du plus ancien message, messages en DLQ (OBS-02).
- Les workers n'ont pas de code d'authentification.

**Ce que ça coûte, et ce qu'il faut surveiller**

- Un service account d'invocation en plus par worker. Le module `service` le crée (SRV-01).
- En push, le worker doit répondre avant la fin du délai d'acquittement (600 s au maximum). Pour les traitements longs, comme le rendu d'image, il faut régler ce délai et le timeout Cloud Run ensemble.
- L'ordre n'est pas garanti : l'idempotence des workers est obligatoire, pas optionnelle.

## En soutenance

- « Le proxy publie et répond. Pub/Sub pousse le message vers le worker avec un token OIDC, et c'est Cloud Run qui vérifie ce token. En cas d'échec, il y a des retries avec backoff, puis la DLQ. »
- « Eventarc a été écarté parce qu'on ne peut pas lui attacher de DLQ en Terraform. »
- « Les événements du bucket et du scheduler passent aussi par Pub/Sub : un seul mécanisme, une seule façon de surveiller. »
