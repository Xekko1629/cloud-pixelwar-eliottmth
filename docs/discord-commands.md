# Enregistrement des commandes Discord

## Objet et périmètre

`app/tools/discord-commands/` est un outil d'administration du catalogue Discord,
pas une Cloud Run function ni un bot WebSocket permanent. Le mode normal
enregistre `/draw`, `/get`, `/snapshot` et `/admin` avec ses sous-commandes.
Il ne reçoit aucune interaction et n'exécute pas leurs actions métier.

Pour ajouter uniquement `/hello nom` en dev, utiliser `--hello` selon le
[guide de la sonde](discord-hello.md). Ce mode fait un POST ciblé, pas un
remplacement du catalogue.

## Contrat des définitions

- `definitions.ts` est la source de vérité, sérialisée en JSON. Palette et bornes
  proviennent de `@pixelwar/shared/grid`.
- Dev : portée guild, avec un serveur de test explicite. Prd : portée globale,
  installations serveur et interactions serveur (`contexts: [0]`,
  `integration_types: [0]`), sans commandes en message privé.
- `/admin` et `/snapshot` ont `default_member_permissions: "0"`, donc une
  visibilité restreinte par défaut. Les intégrations du serveur peuvent autoriser
  des rôles. Cette visibilité **ne remplace pas** la vérification métier dans le
  handler/worker.
- `ratelimit.user` est une option Discord USER (6) : l'ID est une chaîne, pas un
  nombre JS. `limit` va de 0 à `Number.MAX_SAFE_INTEGER` ; zéro n'est pas illimité.
- `size.width` et `size.height` sont optionnels, de 10 000 à 10⁹. Aucune option
  signifie grille infinie ; les deux signifient grille bornée. L'appelant doit
  refuser une seule dimension, car le schéma Discord n'impose pas cette dépendance.

## Prérequis et configuration

1. Installer Node.js 24 et les dépendances : `npm ci` depuis `app/`.
2. Créer une application Discord **distincte par environnement** et, pour dev,
   un serveur de test où l'application est installée avec les autorisations de
   commandes nécessaires.
3. Créer les conteneurs et alimenter les secrets de l'environnement selon le
   [guide Secret Manager](../infra/iam/SECRETS.md). L'identité exécutant l'outil
   doit lire uniquement `discord-application-id` et `discord-bot-token`.
4. Confirmer le projet, l'application et la portée avant tout enregistrement.

| Variable | Rôle |
| --- | --- |
| `APP_ENV` | `dev` ou `prd`, jamais le nom de branche `prod` |
| `DISCORD_APPLICATION_ID` | ID de l'application de cet environnement |
| `DISCORD_GUILD_ID` | Obligatoire en dev ; absente en prd, même pas vide |
| `DISCORD_BOT_TOKEN` | Requis seulement pour une modification réelle |

## Prévisualiser puis enregistrer

Exemple Bash depuis `app/`, avec les IDs réels et une version numérique de secret
sélectionnée par l'opérateur. Pour dev :

```sh
set +x
export APP_ENV=dev
export DISCORD_GUILD_ID='ID_DU_SERVEUR_DE_TEST'
DISCORD_APPLICATION_ID=$(gcloud secrets versions access NUMERO_VERSION \
  --secret=discord-application-id --project=cloud-pixelwar-dev) || exit 1
export DISCORD_APPLICATION_ID
npm run discord:commands
```

Sans `--apply`, aucun appel Discord n'est fait et le token de bot n'est pas
nécessaire. Vérifier la cible et le catalogue affichés. Pour prd, choisir le
projet/application prd, définir `APP_ENV=prd` et retirer `DISCORD_GUILD_ID`.

Après validation explicite de la modification, dans le même terminal :

```sh
DISCORD_BOT_TOKEN=$(gcloud secrets versions access NUMERO_VERSION \
  --secret=discord-bot-token --project=cloud-pixelwar-dev) || exit 1
export DISCORD_BOT_TOKEN
npm run discord:commands -- --apply --confirm-application-id "$DISCORD_APPLICATION_ID"
unset DISCORD_BOT_TOKEN DISCORD_APPLICATION_ID DISCORD_GUILD_ID APP_ENV
```

Remplacer séparément `NUMERO_VERSION` par la version sélectionnée pour chaque
secret ; ne pas supposer qu'elles ont le même numéro. En prd, adapter aussi le
projet de lecture du token. Aucun token en clair dans la commande, le dépôt,
les logs ou un chat ; ne pas activer le traçage shell `set -x`.

**Le PUT remplace toutes les commandes de la portée ciblée**, y compris celles
absentes du catalogue et les autres types de commandes. Les ajouts individuels,
dont `/hello`, peuvent être supprimés. La confirmation de l'ID prévient une
exécution involontaire, mais ne prouve pas que l'application appartient au bon
environnement. Le même PUT est répétable sans doublons ; il consomme néanmoins
des requêtes et quotas. Une autre portée n'est pas nettoyée automatiquement.

## Vérification et diagnostic

- Succès du CLI : Discord a accepté l'enregistrement, pas validé le comportement
  des commandes.
- Dans le serveur : contrôler le catalogue, les options, leur type et les
  permissions avec un compte normal et un compte autorisé.
- Pour les actions : configurer le callback et tester le backend séparément.
  Le catalogue peut être enregistré indépendamment de la disponibilité du handler.
- 429 : respecter `Retry-After` ou `retry_after` ; jusqu'à quatre tentatives,
  fractions de seconde acceptées, arrêt si le délai est invalide ou supérieur à 60 s.
- 5xx : jusqu'à quatre tentatives, attentes de 1, 2 et 4 s. Autres 4xx : arrêt.
- Timeout de 15 s ou erreur réseau : arrêter et vérifier l'état effectif avant
  relance ; une modification peut avoir réussi sans réponse reçue. Aucun rollback
  implicite. Les redirections sont refusées pour ne pas déplacer les credentials.

Le CLI renvoie un code non nul et un message générique sans token, réponse HTTP
brute ou exception sensible. Vérifier configuration et droits sans afficher
les valeurs pour diagnostiquer l'erreur.

## Intégration dans un processus de déploiement

Le workflow `Deploy` n'exécute pas cet outil. Pour l'appeler dans une procédure
ou une automatisation autorisée : utiliser le même commit que le backend,
installer avec `npm ci`, fournir les variables fiables de l'environnement,
prévisualiser puis confirmer la cible, sérialiser les modifications par portée
et traiter tout échec explicitement. En CI, lire les secrets avec WIF et des
droits ciblés, jamais une clé GCP persistante. Ne pas enregistrer de commandes
réelles dans les tests ou sur une PR.

## Mise à jour et retrait

Modifier les définitions versionnées, faire relire leur diff et leur
prévisualisation, puis appliquer dans la bonne portée. Le retrait d'une commande
du catalogue normal prend effet au prochain PUT dans cette portée. Pour une
commande ajoutée individuellement, utiliser son ID et l'opération de suppression
ciblée après validation, sans vider les autres commandes. Coordonner le retrait
avec celui du handler et du callback de l'application.

## Tests et références

Depuis `app/` : `npm run typecheck`, `npm test`, `npm run test:coverage`.
Les tests simulent l'API Discord : catalogue, cibles, confirmation, méthodes
HTTP, erreurs et délais. Ils ne prouvent pas l'autorisation du serveur réel.

- [Commandes, options, permissions et enregistrement](https://docs.discord.com/developers/interactions/application-commands)
- [Limites de débit Discord](https://docs.discord.com/developers/topics/rate-limits)
- [Exécution TypeScript avec tsx](https://tsx.hirok.io/)
