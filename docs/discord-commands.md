# BOT-02 — Enregistrement des commandes Discord

## Périmètre

`app/tools/discord-commands/` est un outil de déploiement, **pas une fonction Cloud
Run** et pas un bot Gateway permanent. Il enregistre quatre commandes HTTP
Discord API v10 : `/draw`, `/get`, `/snapshot` et `/admin` avec ses cinq sous-commandes.
Il ne traite aucune interaction et n'implémente aucune action métier.
Les brouillons non suivis dans `app/functions/discord-bot/` restent inchangés.

- Les définitions TypeScript sont la source de vérité ; `JSON.stringify` produit
  le payload JSON. Palette et bornes proviennent de `@pixelwar/shared/grid`.
- Dev : commandes limitées au serveur de test. Prd : commandes globales, mais
  uniquement utilisables dans les serveurs et pour une installation serveur
  (`contexts: [0]`, `integration_types: [0]`). Pas de commandes en DM.
- `/admin` et, provisoirement, `/snapshot` ont `default_member_permissions: "0"` :
  désactivées par défaut sauf pour les administrateurs Discord. Un responsable
  du serveur peut autoriser le rôle Pixelwar Admin dans Paramètres du serveur →
  Intégrations. Cette visibilité n'est **pas** une autorisation métier ; les workers
  doivent toujours vérifier l'allow-list et/ou le rôle (BOT-08 et handler snapshot).
  La restriction de snapshot suit l'interprétation prudente du sujet, à confirmer
  avec l'encadrant.
- `ratelimit.user` est de type Discord USER (6), pas un nombre JS ; l'ID reçu
  reste une chaîne. `limit` est un entier de 0 à `Number.MAX_SAFE_INTEGER` :
  0 signifie quota nul, pas illimité. Le worker doit revalider ces entrées.
- `size.width` et `size.height` sont optionnels et bornés à 10 000..10⁹.
  Aucune option = grille infinie ; deux options = grille bornée. Discord ne peut
  pas imposer « les deux ou aucune » : le worker devra refuser une option seule.

## Utilisation locale — Node.js 24

Depuis `app/`, après `npm ci`, une prévisualisation ne demande **aucun token**
et ne fait aucun appel réseau :

```sh
APP_ENV=dev \
DISCORD_APPLICATION_ID=123456789012345678 \
DISCORD_GUILD_ID=234567890123456789 \
npm run discord:commands
```

Les IDs ci-dessus sont fictifs. Pour prd : `APP_ENV=prd`, ID de l'application prd
et variable `DISCORD_GUILD_ID` **absente**, même pas une chaîne vide.
Ne pas confondre `prd` (environnement) et `prod` (branche).

Un envoi réel exige explicitement :

```sh
npm run discord:commands -- --apply --confirm-application-id "$DISCORD_APPLICATION_ID"
```

Il faut alors injecter `APP_ENV`, `DISCORD_APPLICATION_ID`, `DISCORD_GUILD_ID`
(dev seulement), et `DISCORD_BOT_TOKEN` dans l'environnement du processus depuis
une source sûre. Ne pas saisir le token en clair dans une commande, le dépôt,
un fichier versionné ou un chat. Ne pas activer `set -x`.

**Attention : bulk overwrite remplace toutes les commandes de la portée ciblée,
y compris les types non présents dans ce catalogue.** Des commandes ajoutées à la
main dans cette même portée seront supprimées. La confirmation protège contre
une exécution involontaire ; elle ne prouve pas que l'ID appartient au bon
environnement. BOT-01 doit fournir deux applications distinctes.

Le PUT est répétable : même payload → même catalogue, sans doublons de commandes.
Cela ne signifie pas absence de requêtes, de quotas ou de changements de versions
côté Discord. Les anciennes commandes d'une **autre portée** ne sont pas nettoyées.
Un changement guild/global nécessite une migration explicite.

## Erreurs et sécurité

- 429 : attendre `Retry-After` en secondes, sinon `retry_after` du JSON ; délai
  fractionnaire accepté. Arrêt si absent/invalide ou supérieur à 60 s, sans
  réessayer trop tôt. Au maximum quatre tentatives.
- 5xx : jusqu'à quatre tentatives avec attentes de 1, 2 et 4 s.
- 4xx hors 429 : arrêt immédiat (401 : token ; 403 : accès ; 404 : cible).
- Réseau/timeout : arrêt, vérifier l'état avant de relancer le PUT. Timeout de
  15 s par requête ; redirections interdites pour ne pas déplacer le token.
- Ni token, ni corps de réponse Discord, ni exception HTTP brute ne sont loggés.
  Le CLI émet un message générique et un code de sortie 1 en cas d'échec.
  Un échec d'acquittement peut suivre une mise à jour déjà appliquée : vérifier
  Discord ou rejouer le PUT, pas supposer un rollback.

## Contrat d'intégration SRV-02 — pas encore branché

Le workflow actuel déploie l'infrastructure, pas les fonctions applicatives.
Ne pas y ajouter un appel sans déploiement applicatif préalable.
SRV-02 devra appeler le script **après chaque déploiement applicatif réussi** :

1. Checkout du même commit que celui déployé, Node 24, `npm ci` depuis `app/`.
2. Sélection du projet (`cloud-pixelwar-dev` ou `cloud-pixelwar-prod`) via une
   configuration d'environnement fiable. Utiliser WIF, jamais une clé GCP.
3. Lire les versions sélectionnées de `discord-application-id` et
   `discord-bot-token` dans Secret Manager ; masquer le token avant tout affichage.
   Accorder `secretAccessor` uniquement sur ces secrets à l'identité chargée de
   l'enregistrement. Pas de rôle global ou d'accès aux secrets OAuth inutiles.
4. Fournir l'ID de serveur de test via la configuration dev ; ne pas fournir
   `DISCORD_GUILD_ID` à prd. Exécuter d'abord le dry-run, puis l'appel `--apply`
   explicitement confirmé par l'ID de l'application de cet environnement.
5. Sérialiser déploiement et enregistrement par environnement, garder les
   approbations prd et faire échouer la release si le script échoue.

Pas d'enregistrement sur une PR ni dans les tests. L'enregistrement n'a pas
besoin de la clé publique ou de l'URL d'interactions, mais une commande ne
fonctionnera réellement que lorsque BOT-03 et les workers seront prêts.

## Validation

```sh
npm run typecheck
npm test
npm run test:coverage
```

Tests du catalogue, cibles dev/prd, confirmation, PUT répétable, erreurs 4xx/5xx,
429, timeout/réseau simulés et CLI en sous-processus. Aucun envoi réel à Discord.
L'enregistrement réel, l'autorisation serveur et l'exécution après déploiement
restent à vérifier avec BOT-01/SRV-02 ; le ticket n'est pas validé de bout en bout.

### Première validation dev après merge

1. CI verte sur le commit courant de BOT-02, basé sur le `prod` contenant
   TEST-01, DATA-01, SRV-03 et SRV-08. Vérifier que les trois exports du shared
   (`grid`, `observability`, `observability/google`) sont conservés et que
   `npm ci` accepte le lockfile sans le régénérer.
2. Valider séparément le plan puis le déploiement Terraform dev, suivant
   [la checklist SRV-03](../infra/serverless/SECRETS.md). Ce workflow applique
   `foundation` et `serverless` ; il **n'enregistre pas** les commandes Discord.
   Ne pas pousser de tag `v*` pour ce test, car cela engage aussi prd.
3. Alimenter les secrets depuis l'application **dev** de BOT-01. Fournir au
   script son Application ID et l'ID du serveur de test ; garder le token hors
   des commandes en clair, des logs et du dépôt.
4. Exécuter la prévisualisation sans `--apply` : contrôler la cible guild dev,
   les quatre commandes principales, les cinq sous-commandes admin et les
   seize choix de couleur. À ce stade aucun appel Discord n'est effectué.
5. Après accord explicite, enregistrer avec `--apply --confirm-application-id`
   et vérifier le catalogue dans le serveur de test. Répéter le même appel
   autorisé pour constater l'absence de doublons dans cette portée.
6. Vérifier la visibilité avec un compte normal et un compte autorisé. Pour
   le rôle métier Pixelwar Admin sans permission Discord Administrator,
   configurer explicitement les accès dans les intégrations du serveur.

Ces essais réels ne sont **pas** exécutés par la CI ni lors du développement
local. Leur résultat devra être consigné après réalisation. Tant que BOT-03 et
les workers ne sont pas déployés, une commande visible peut échouer lorsqu'on
l'invoque : aucun test de dessin, signature/PING, quota ou autorisation métier
n'est validé par le seul enregistrement des commandes. DATA-03 n'est pas un
prérequis pour créer les secrets ou enregistrer ce catalogue ; il est requis
pour valider les quotas avant l'ouverture du dessin aux utilisateurs.

## Sources

Consultées le 5 novembre 2026 :
- [Discord — commandes, options, permissions et bulk overwrite](https://docs.discord.com/developers/interactions/application-commands)
- [Discord — limites de débit et Retry-After](https://docs.discord.com/developers/topics/rate-limits)
- [tsx — exécution TypeScript](https://tsx.hirok.io/)
- [Node 24 — contraintes du TypeScript natif](https://nodejs.org/docs/latest-v24.x/api/typescript.html)
