# Notifier Discord : retour du dessin à l'utilisateur

## Responsabilité

`app/functions/discord-notifier`, entrée HTTP Node.js 24 `handleDiscordNotifier`,
consomme `pixel-processed` et `pixel-rejected`. Pour une demande Discord, il
modifie la réponse différée d'origine. Un résultat web valide est acquitté sans
appel Discord. Le notifier ne dessine pas, ne modifie pas le quota et n'appelle
ni Firestore ni un endpoint de création de message.

Il complète le parcours applicatif suivant, sans modifier le proxy Q2 :

```text
/draw → discord-proxy → discord-command → command-worker
      → pixel-draw → draw-worker / DATA-02
      → pixel-processed ou pixel-rejected → discord-notifier
      → PATCH de la réponse Discord d'origine
```

Les contrats de résultat sont ceux de [DRAW-02](draw-worker.md), exposés par
`@pixelwar/shared/events`. Leur revue ARCH-03 reste nécessaire avant raccordement
cloud. Les résultats admin sont envoyés par l'`admin-worker` lui-même, les rendus
et snapshots par leurs workers.

Le notifier répond aussi aux refus `command-rejected` du `command-worker`
(BOT-08) : `/admin` ou `/snapshot` demandés hors allow-list reçoivent un message
fixe « réservée aux administrateurs », par le même `PATCH @original`. Ce troisième
abonnement est facultatif ; sans lui, le notifier ne traite que les dessins.
Le `PATCH` est fait par le client partagé `@pixelwar/shared/discord`.

## Validation des messages

La fonction vérifie le format push Pub/Sub, le nom complet de l'abonnement,
le `messageId`, le base64 canonique et le JSON UTF-8. Le corps brut est limité à
128 Kio, le champ base64 à 64 Kio avant décodage.

Le type de résultat doit correspondre à son abonnement configuré. Les UUID,
dates, auteur, source, identifiants demande/résultat et compteurs sont recoupés.
L'ID de l'enveloppe est recalculé comme dans DRAW-02, à partir de la demande.
Un résultat ne peut pas prétendre simultanément à un succès et à un refus.
Les champs de quota inutilisés ne sont ni affichés ni retransmis à Discord.

Pour Discord, le contexte doit correspondre à l'application attendue ; l'ID de
demande et sa date sont recoupés avec l'interaction. La date de création utilisée
pour l'expiration vient donc de l'interaction, **pas de la date de traitement**.
Un résultat web ne doit pas contenir de contexte Discord.

Les attributs autorisés sont exactement `correlation_id` et un `traceparent`
W3C valide, comme dans les autres workers. Le notifier restaure un span
consommateur SRV-08 et relie ses logs à cette trace. L'export configuré est
attendu avant acquittement ; sa réception par GCP reste à valider en dev.

## Message affiché et doublons

Seul l'endpoint suivant est appelé, avec l'origine fixe `https://discord.com` :

```text
PATCH /api/v10/webhooks/<application_id>/<interaction_token>/messages/@original
```

Le token est encodé en un seul segment de chemin. Aucune URL provenant d'un
message ou d'une variable d'environnement ne choisit la destination réseau.
Les redirections sont refusées. Aucun token bot ni en-tête `Authorization` n'est
nécessaire pour cette route d'interaction.

Le contenu est déterministe et ne reprend aucun nom utilisateur ou texte libre :

| Résultat | Réponse affichée |
| --- | --- |
| Succès | Nombre de pixels appliqués et ignorés, sans prétendre avoir redessiné les pixels dépassés |
| `rate_limit` | Quota dépassé, aucun pixel de ce lot dessiné |
| `paused` | Dessin en pause |
| `out_of_bounds` | Coordonnées hors de la grille |
| `expired` | Demande trop ancienne |
| `batch_budget_exceeded` | Lot dépassant les limites de traitement |

Les mentions sont désactivées via `allowed_mentions.parse: []` ; embeds et
components sont vides. Une relivraison répète le même PATCH avec le même contenu
sur **le même message**. Aucun suivi par POST ni stockage de déduplication
supplémentaire n'est utilisé. Cela garantit un effet de remplacement répétable,
pas une seule requête réseau. DATA-02 protège séparément dessin et quota.

## Expiration et erreurs

Politique retenue : un token est considéré expiré à partir de **15 minutes**
après création de l'interaction, y compris exactement à cette limite.

- Token encore utilisable : attendre le PATCH confirmé avant `204`.
- Réseau, timeout, HTTP non-2xx ou rate limit : `503` pour permettre une reprise.
  Une erreur Discord `404` avant l'échéance n'est pas assimilée automatiquement
  à une expiration ; elle peut aussi précéder la disponibilité du message initial.
- Token expiré : **ne plus appeler Discord**, log `WARNING` avec
  `discord.notification.expired`, puis `204`. Le résultat du dessin est conservé,
  mais l'utilisateur n'aura pas sa confirmation finale. Aucun message de secours
  n'est posté dans le canal.
- Si un échec réseau/HTTP survient pendant que le token expire, la même politique
  d'expiration s'applique. Un succès déjà confirmé reste un succès.
- Horloge invalide ou interaction trop future par rapport au worker : `503`,
  sans masquer un problème d'horloge par un acquittement.

Le timeout HTTP est de 5 secondes, réduit au temps restant du token. Il n'y a
pas de boucle de retry interne ni de travail après la réponse. Un `Retry-After`
numérique est assaini et retourné comme indication HTTP ; ce n'est **pas** une
garantie que Pub/Sub respectera ce délai. Les véritables reprises dépendent du
backoff, du nombre de tentatives et de la DLQ de chaque abonnement : un message
peut atteindre la DLQ avant les 15 minutes. Ce changement n'en modifie aucun.

| Situation | Réponse |
| --- | --- |
| PATCH confirmé, résultat web ignoré ou notification expirée journalisée | `204` |
| Contrat/enveloppe invalide | `400` |
| Configuration, horloge, log ou appel Discord en échec avant expiration | `503` |
| Corps brut absent/trop grand | `413` |
| Mauvais chemin/méthode | `404` / `405` |

L'acquittement concerne uniquement l'abonnement du notifier ; il ne supprime
pas les résultats d'autres consommateurs Pub/Sub.

## Configuration et sécurité

| Variable | Usage |
| --- | --- |
| `DISCORD_APPLICATION_ID` | Application attendue |
| `DISCORD_PROCESSED_SUBSCRIPTION` | Nom complet de l'abonnement des succès |
| `DISCORD_REJECTED_SUBSCRIPTION` | Nom complet distinct de l'abonnement des refus |
| `DISCORD_COMMAND_REJECTED_SUBSCRIPTION` | Facultatif : nom complet distinct de l'abonnement `command-rejected` |

L'absence ou l'invalidité de ces paramètres rend le handler indisponible (`503`).
La fonction reste privée, avec push OIDC et invoker dédiés : abonnements
`discord-notifier-processed` et `discord-notifier-rejected` dans
`infra/serverless/draw-path.tf` ([déploiement dev](deploy-draw-path.md)).
L'abonnement `command-rejected` est ajouté avec l'étape admin.

Le token est présent dans les messages Pub/Sub et dans l'URL du PATCH : ne jamais
logguer le corps, l'URL, les exceptions réseau ou les réponses Discord. Le client
ne lit pas le corps de réponse et le libère sans l'afficher. Les erreurs sont
remplacées par des catégories fixes ; seuls les IDs techniques et éventuellement
un statut HTTP numérique peuvent atteindre les logs. Le span consommateur
n'enregistre ni URL, ni chemin, ni corps : le token de l'interaction reste hors
des traces et des labels de métriques.

## Tests et limites de preuve

Depuis `app/` :

```bash
npm ci
npm run typecheck
npm run test:coverage
npm run test:integration
npm run build:functions
```

Les tests unitaires/HTTP couvrent les messages affichés, doublons, expiration à
la limite, erreurs réseau/HTTP, rate limits, redirections, timeout et logs sûrs.
Une fausse API Discord écoute uniquement sur `127.0.0.1` ; les tokens sont
synthétiques. Le transport de test ne peut pas envoyer ces requêtes à Discord.

Le test de parcours complet fait passer une interaction signée par les quatre
handlers, avec de vrais messages Pub/Sub émulateur et une transaction Firestore
émulateur, jusqu'au PATCH local. La livraison push entre handlers est adaptée par
le test, pas assurée par GCP. Il ne prouve ni API Gateway, ni IAM/OIDC, ni les
limites réelles Discord : un essai dev autorisé reste nécessaire avant clôture
du parcours de bout en bout déployé.

Référence consultée le 20 novembre 2026 : [documentation officielle Discord —
interaction responses et edit original](https://docs.discord.com/developers/interactions/receiving-and-responding#edit-original-interaction-response).
