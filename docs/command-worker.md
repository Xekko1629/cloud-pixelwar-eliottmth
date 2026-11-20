# Routage des commandes Discord

## Responsabilité

`app/functions/command-worker` est une fonction HTTP Node.js 24, entrée
`handleCommandWorker`, appelée par un abonnement Pub/Sub push authentifié OIDC.
Cloud Run doit vérifier l'identité avant le handler ; le code valide le message,
les autorisations métier et la publication de l'événement suivant.

Il ne dessine pas, ne modifie ni quota ni configuration Firestore, ne rend pas
d'image et n'appelle pas Discord. Le worker temporaire `discord-command-verify`
reste distinct : aucune substitution d'abonnement ou de ressource n'est implicite.

## Contrats proposés et compatibilité

Les types de sortie sont exposés par `@pixelwar/shared/events`, pour éviter
qu'une fonction importe l'implémentation d'une autre. Leur publication dans le
catalogue ARCH-03 et leur revue avec les consommateurs restent nécessaires avant
raccordement. La structure actuelle `/draw` de BOT-03 est conservée en entrée.

Les autres commandes étendent ce contrat provisoire : même enveloppe
`schema_version: 1`, `source: discord`, `actor` et contexte d'interaction ; seuls
`payload.command` et `payload.options` changent. L'ID UUIDv8 est recalculé à partir
de l'application et de l'interaction, comme dans BOT-03. La date doit correspondre
à la date contenue dans l'ID Discord. Le nom utilisateur respecte le modèle de
grille : 1–32 caractères Unicode, au plus 128 octets UTF-8.

| Commande | Options en entrée | Type/topic logique de sortie |
| --- | --- | --- |
| `draw` | `{ x, y, color }` | `pixel-draw` |
| `get` | `{}` | `render-requested` |
| `snapshot` autorisé | `{}` | `snapshot-requested` |
| `admin` autorisé | `{ subcommand, ... }` | `admin-requested` |
| `admin` ou `snapshot` refusé | Options de la commande | `command-rejected` |

Sous-commandes admin : `pause`, `resume`, `clear` sans autre option ; `ratelimit`
avec `user` et `limit` entier positif ou nul ; `size` sans dimensions (grille
infinie), ou avec `width` **et** `height` entre 10 000 et la borne technique.
Une option inconnue ou une paire incomplète est refusée.

Chaque sortie contient `schema_version`, `type`, `event_id`, `correlation_id`,
`occurred_at`, `source`, `actor: { uid, name }` et `payload`. Pour le dessin,
`payload.pixels` contient un lot d'un pixel ; le futur `draw-worker` le transmettra
au moteur DATA-02 en utilisant `actor` comme auteur. Les rôles ne sont pas propagés.
`payload.discord` conserve le contexte nécessaire au futur notifier, notamment
le token d'interaction **sensible**. Aucun corps ou token ne doit être loggé.

## Autorisation et refus

La configuration impose deux listes explicites : `user_ids` et `role_ids`.
Un ID utilisateur présent **ou** un rôle présent autorise l'administration.
La visibilité des commandes et les permissions dans l'interface Discord ne
remplacent pas ce contrôle. La politique `/snapshot` est restrictive, comme
BOT-02, dans l'attente de clarification du sujet.

Une configuration absente ou invalide rend la fonction indisponible (`503`).
Deux listes explicitement vides sont valides : personne n'est administrateur.
Un refus produit `command-rejected` avec `reason: unauthorized`, auquel le
`discord-notifier` répond. Aucun effet admin n'est exécuté par ce routeur :
`admin-requested` est appliqué par l'`admin-worker` (BOT-08), qui reçoit les rôles
de l'auteur dans `actor.roles` et revérifie l'allow-list.

## Doublons et acquittement

Une interaction conserve le même `event_id` en sortie, indépendamment du
`messageId` Pub/Sub et du nombre de livraisons. À entrée et configuration
identiques, le résultat de routage est identique. Il n'y a ni cache mémoire de
déduplication ni transaction Firestore dans ce routeur.

La même interaction peut donc être publiée plusieurs fois. Les consommateurs
doivent protéger leurs effets par cet ID : DATA-02 enregistre dessin, quota et
résultat ensemble ; à la relivraison, il reprend le résultat sans redessiner.
Le notifier doit lui aussi supporter des résultats répétés.

L'autorisation est vérifiée avec la configuration de chaque instance. Une
rotation des listes peut changer la décision lors d'une reprise : aucune
décision d'autorisation durable n'est promise par ce routeur. Le traitement admin
final devra également contrôler les droits avant d'effectuer une modification.

| Situation | Réponse HTTP |
| --- | --- |
| Publication confirmée, y compris refus métier publié | `204` |
| Message/commande/attributs invalides | `400`, réessayable puis DLQ selon abonnement |
| Configuration, topic ou publication indisponible ; échec d'écriture du log | `503` |
| Corps brut absent ou supérieur à 128 Kio | `413` |
| Chemin autre que `/` ou méthode autre que POST | `404` / `405` |

La fonction attend la publication avant le 2xx et ne lance aucun travail après
la réponse. En cas d'échec après publication mais avant acquittement, elle peut
republier le même ID. « Une seule publication » n'est **pas** garanti ; le choix
retenu porte sur l'idempotence des effets métier, conformément à ADR-0002.

Les attributs de transport sont limités à `correlation_id` et `traceparent` W3C
valide (sampled ou non), sans copie d'attribut arbitraire ni de token. Le routeur
ouvre un span consommateur SRV-08, publie le contexte de son propre span et relie
ses logs à la trace. Les logs utilisent uniquement des champs techniques
explicitement sélectionnés ; les erreurs SDK ne sont jamais sérialisées.

## Configuration et raccordement ultérieur

| Variable | Valeur attendue |
| --- | --- |
| `GOOGLE_CLOUD_PROJECT` | Projet d'exécution |
| `DISCORD_APPLICATION_ID` | Application Discord attendue |
| `DISCORD_COMMAND_SUBSCRIPTION` | Nom complet de l'abonnement source |
| `DISCORD_ADMIN_ALLOWLIST` | JSON secret `{ "user_ids": [], "role_ids": [] }` |
| `PIXEL_DRAW_TOPIC` | Nom court du topic de dessin |
| `RENDER_REQUESTED_TOPIC` | Nom court du topic de rendu |
| `SNAPSHOT_REQUESTED_TOPIC` | Nom court du topic de snapshot |
| `ADMIN_REQUESTED_TOPIC` | Nom court du topic admin proposé |
| `COMMAND_REJECTED_TOPIC` | Nom court du topic des refus proposé |

Un topic non configuré échoue uniquement quand sa route est utilisée, sans
acquitter le message. Le publisher initialise son client à la première
publication, met en cache les topics et borne le RPC à 5 secondes sans retry
SDK ; cette borne ne garantit pas la durée totale d'un cold start.

Le proxy BOT-03 reste limité à `/draw`. Aucun topic, abonnement, droit IAM ou
Terraform du worker n'est ajouté ici. L'activation d'autres commandes, les
consommateurs admin/rendu/notification, les ressources et le raccordement push
doivent être revus et validés séparément avant utilisation réelle.

## Validation locale

Depuis `app/` :

```bash
npm ci
npm run typecheck
npm run test:coverage
npm run test:integration
npm run build:functions
```

Tests : contrat BOT-03 réel, options par commande, refus d'autorisation, doublons,
confirmation avant réponse, panne de publication, logs sûrs, serveur Functions
Framework et publication effective dans Pub/Sub émulateur. Le projet de test est
`demo-pixelwar-test` ; aucun credential Discord réel n'est nécessaire.
Ces tests ne prouvent ni IAM/OIDC ni le fonctionnement de la chaîne déployée.
