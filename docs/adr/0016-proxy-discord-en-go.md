# ADR-0016 · Proxy Discord en Go

- **Statut** : Proposé
- **Date** : 2026-11-21
- **Tickets** : BOT-03 (#50), BOT-05 (#52), SRV-05 (#35), SRV-08 (#38). Complète [ADR-0008](0008-compute-cloud-run-functions.md) pour la seule fonction `discord-proxy`.
- **Références** : [Interactions Discord, délai de réponse](https://discord.com/developers/docs/interactions/receiving-and-responding) · [Dépannage API Gateway (cold start)](https://docs.cloud.google.com/api-gateway/docs/troubleshoot) · [Conseils Cloud Run sur le démarrage](https://docs.cloud.google.com/run/docs/tips) · [API REST Pub/Sub, `topics.publish`](https://cloud.google.com/pubsub/docs/reference/rest/v1/projects.topics/publish) · `docs/deploy-draw-path.md`

## Contexte

- Discord attend la réponse à une interaction en **3 secondes**, sans nouvel
  essai. Passé ce délai, l'utilisateur voit « L'application ne répond plus » et
  l'interaction est perdue.
- Mesures en dev du 21/11/2026, entre le démarrage d'une instance et sa sonde de
  démarrage réussie (logs Cloud Run) :

  | Fonction | Médiane | Chargé au démarrage |
  |---|---|---|
  | `frontend` (nginx, binaire natif) | 0,27 s | — |
  | `discord-hello` | 1,26 s | Node.js, Functions Framework |
  | `discord-notifier` | 1,95 s | + OpenTelemetry |
  | `discord-proxy` | 2,73 s | + client Pub/Sub (gRPC) |

- En local, le chargement du proxy ouvre 945 fichiers, dont 644 pour le client
  Pub/Sub et environ 480 pour OpenTelemetry. Embarquer le client Pub/Sub dans un
  seul fichier échoue : `google-gax` lit des fichiers `.proto` à l'exécution.
- La première requête d'une instance coûte encore environ 0,45 s : compilation à
  la volée du JavaScript, jeton Google, connexion TLS et canal gRPC vers Pub/Sub.
- Le démarrage à froid de l'API Gateway (3 à 5 s après 15 à 20 minutes sans
  trafic) et la concurrence d'une requête par instance sont traités à part :
  job Cloud Scheduler toutes les 5 minutes et concurrence 16.
- Le proxy n'a presque aucune règle métier : vérifier la signature Ed25519,
  construire l'enveloppe `discord-command` v1, publier, répondre. Le contrat est
  déjà vérifié contre le `command-worker` par des tests.

## Décision

### Langage et runtime

- La fonction `discord-proxy` est écrite en **Go**, runtime Cloud Functions
  `go126`, toujours déployée depuis une archive de sources (ADR-0009). Les autres
  fonctions restent en TypeScript sur Node.js 24.
- Le comportement HTTP est identique à la version TypeScript : PING, `401` sur
  signature invalide (fenêtre de ±5 minutes), `/draw` et `/admin` publiés,
  réponses éphémères, `/discord/health`, pseudo coupé à 32 caractères, mêmes
  messages d'erreur et mêmes codes.

### Publication

- Publication par l'**API REST** `topics.publish`, avec la bibliothèque standard
  de Go. Le jeton d'accès du compte d'exécution est lu sur le serveur de
  métadonnées et mis en cache jusqu'à une minute avant son expiration.
- Au démarrage, une tâche de fond récupère le jeton et ouvre la connexion TLS
  vers `pubsub.googleapis.com`, pour que la première commande ne paie que l'appel
  de publication. Le délai de publication reste borné à 1 seconde, sans nouvel essai.

### Observabilité

- OpenTelemetry Go garde le span serveur `discord.interactions.draw`, ses
  attributs et le compteur `pixelwar.function.attempts` (mêmes noms et libellés
  qu'en TypeScript), exportés en OTLP vers `telemetry.googleapis.com` et vidés
  avant la réponse. Le `traceparent` publié continue donc la même trace jusqu'au
  `discord-notifier`.
- Les logs JSON gardent les champs du logger partagé (`severity`, `function`,
  `event_type`, `correlation_id`, champs `logging.googleapis.com/trace`). Aucun
  token, corps de requête ou message d'erreur amont n'est journalisé.

### Équivalence avec la version TypeScript

- Des fichiers de référence sont produits par les tests TypeScript à partir
  d'interactions signées par une clé de test fixe. Pour chaque cas, ils décrivent
  la requête, le code et le corps de la réponse, et le message publié.
- Les tests TypeScript vérifient que le handler TypeScript produit toujours ces
  fichiers ; les tests Go vérifient que le handler Go produit les mêmes. Un écart
  de contrat entre les deux langages fait échouer la CI.
- La version TypeScript reste dans le dépôt comme implémentation de référence du
  contrat, tant que le `command-worker` et ses tests s'appuient sur elle.

## Options écartées

- **Alléger la version Node.js** (OpenTelemetry embarqué, publication REST) :
  démarrage estimé autour de 1,3 à 1,6 s, encore proche du délai de Discord en
  cas de pic de la plateforme.
- **Garder une instance toujours prête sans changer de langage** : supprime le
  démarrage à froid du cas courant, mais pas celui d'une deuxième instance, et
  coûte environ 8 à 10 $ par mois et par environnement.
- **Rust** : démarrage comparable à Go, mais pas de runtime Cloud Functions ; il
  faudrait un service Cloud Run construit depuis une image, avec une autre
  chaîne de build et un autre module Terraform.
- **Tous les proxies en Go** : `web-proxy`, `tile-reader` et `auth-proxy` n'ont
  pas de délai imposé et partagent beaucoup de règles avec les workers (grille,
  quota, codec des régions, télémétrie). Les dupliquer créerait deux
  implémentations des mêmes règles.
- **Client officiel `cloud.google.com/go/pubsub`** : canal gRPC plus long à établir
  et dépendances inutiles pour un seul message par requête.
- **Sans SDK OpenTelemetry** (seulement `traceparent` et logs corrélés) : le span
  du proxy disparaîtrait de Cloud Trace et casserait la trace de bout en bout.

## Conséquences

- Démarrage à froid attendu sous 1 seconde pour le proxy : à confirmer par les
  logs de démarrage et la latence de la gateway en dev.
- Un deuxième langage dans le dépôt, avec sa chaîne de test en CI et ses
  dépendances (`go.mod`, `go.sum`).
- Toute évolution du contrat `discord-command` ou des réponses Discord se fait
  dans les deux versions, sous le contrôle des fichiers de référence.
- L'instance toujours prête du proxy est retirée avec ce changement
  (`min_instances = 0`), sur la foi des mesures locales. Si le premier appel à
  froid mesuré en dev dépasse 1 s, on la remet (une ligne dans
  `infra/serverless/discord-proxy.tf`).
