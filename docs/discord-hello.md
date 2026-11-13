# Callback Discord et `/hello nom` — sonde temporaire dev

Ce guide décrit la configuration, le déploiement et le retrait de la sonde HTTP
dev. Pour installer l'environnement depuis zéro, suivre d'abord
[le guide de déploiement](deployment.md).

## Périmètre

```text
Discord → POST <gateway_url>/discord/interactions → discord-hello → réponse Discord
```

Le handler HTTP Node.js 24 vérifie Ed25519 sur `timestamp + rawBody`, refuse les
timestamps décalés de plus de cinq minutes, puis :

- `PING` (`type: 1`) → `PONG` (`{ "type": 1 }`) ;
- `/hello nom:Benjamin` → `Hello Benjamin !` (réponse immédiate `type: 4`) ;
- autres commandes → message éphémère expliquant que seul `/hello` est disponible.

`nom` est obligatoire, de 1 à 80 caractères ; les mentions sont désactivées.
Les noms, tokens, corps et signatures ne sont jamais journalisés par le handler.
La fonction ne publie pas dans Pub/Sub et n'effectue aucun traitement métier.
La sonde utilise le logger, pas les exporteurs Cloud Trace : vérifier une trace
avec une fonction instrumentée selon le [guide d'observabilité](observability.md).

Le callback remplace l'URL d'interactions de **toute l'application dev** : les quatre
commandes restent enregistrées, mais leurs actions ne sont pas implémentées ici.
Ne pas modifier l'application Discord prd.

## Avant tout déploiement

1. Faire relire le code et les plans de PR, puis committer/pousser selon le GitFlow.
2. Vérifier dans `cloud-pixelwar-dev` que `discord-public-key` contient bien la clé
   publique de l'application Discord **dev**, et que sa version est activée.
   Ne pas coller sa valeur dans les fichiers Terraform. Le module référence une
   version numérique : `discord_hello_public_key_version` vaut `"1"` par défaut.
3. `enable_discord_hello = true` dans `dev.tfvars` active la sonde. Le module refuse
   de créer la fonction ou sa route en prd, même si l'option est activée par erreur.
4. Vérifier les ressources attendues : fonction et runtime `discord-hello`, archive,
   API Gateway et son identité, droits d'invocation limités à la gateway, accès au
   seul secret `discord-public-key`. Aucun token de bot n'est nécessaire au runtime.
5. **Obtenir la validation explicite avant de lancer le workflow `Deploy` manuel
   en dev.** Celui-ci applique aussi foundation et bootstrap ; ce n'est pas un
   déploiement limité à la sonde. Un tag de release peut également viser prd :
   ne pas en poser pour ce premier essai.

## Déployer en dev, étape par étape

Exécuter les commandes après validation de la cible et du plan. Le déploiement
est effectué par la CI, pas par un `gcloud functions deploy` ou un
`terraform apply` local parallèle.

### 1. Sélectionner une version et vérifier la configuration

Utiliser une version du dépôt contenant la sonde, publiée selon le
[GitFlow](gitflow.md). Faire relire les plans **dev et prd** avant déploiement :
prd ne doit pas créer `discord-hello` ni sa gateway temporaire. Examiner aussi
les autres ressources du plan ; une fusion seule ne déploie rien.

Vérifier les métadonnées de la version du secret, sans en lire la valeur :

```sh
gcloud secrets versions describe 1 \
  --secret=discord-public-key --project=cloud-pixelwar-dev \
  --format='value(state)'
```

Le résultat doit être `ENABLED`. Cela ne prouve pas que la clé appartient à la
bonne application : le responsable Discord doit aussi confirmer sa provenance.
Si une autre version est utilisée, adapter la référence numérique avant la PR.

### 2. Déclencher le workflow manuel, sans tag

Dans le dépôt GitHub :

1. **Actions → Deploy → Run workflow**.
2. Sélectionner la branche contenant la version approuvée pour l'essai dev
   (par exemple `feature/discord-hello-check` pour tester avant fusion), ou
   **`prod`** après fusion. Les restrictions de l'environnement GitHub `dev`
   doivent autoriser la branche choisie.
3. Renseigner **`runner = ubuntu-latest`** pour que les contrôles n'attendent pas
   un runner GKE disponible.
4. Vérifier une dernière fois le commit et le périmètre, puis cliquer sur
   **Run workflow** après accord explicite.

Alternative CLI, à la place du clic — **ne pas exécuter les deux** :

```sh
gh workflow run deploy.yml \
  --repo Xekko1629/cloud-pixelwar-eliottmth \
  --ref feature/discord-hello-check -f runner=ubuntu-latest
```

Cette commande modifie GCP en lançant le workflow. L'exécution manuelle du
workflow actuel cible **dev seulement**, sans input d'environnement. Elle
applique `foundation` et `bootstrap`, puis `serverless` : elle peut donc créer ou
modifier le cluster/réseau et engendrer des coûts, pas seulement la fonction.
`iam` et `access` doivent être prêts ; ils ne sont pas appliqués ici.

Ne pas poser de tag `v*` : le chemin de release sur tag vise également prd.

### 3. Vérifier le run avant de toucher à Discord

Dans le run Actions, vérifier :

- contrôles verts ;
- `apply-dev`, `apply-bootstrap-dev` et `apply-serverless-dev` réussis ;
- jobs `apply-prd`, `apply-bootstrap-prd`, `apply-serverless-prd` et
  `apply-runners-prd` **ignorés** ;
- dans l'apply serverless : fonction `discord-hello`, Gateway et outputs non nuls.

En cas d'erreur, arrêter ici. Pour un échec de construction de fonction,
consulter le lien/identifiant Cloud Build dans les logs : ne pas modifier l'URL
Discord pour tenter de résoudre un build ou une erreur IAM.

### 4. Récupérer les URLs sans nouvel apply

Utiliser le checkout du commit effectivement déployé et une authentification
GCP autorisée à lire le backend dev. Depuis la racine du dépôt :

```sh
terraform -chdir=infra/serverless init -reconfigure \
  -backend-config=backends/dev.hcl
GATEWAY_URL=$(terraform -chdir=infra/serverless output -raw gateway_url)
FUNCTION_URL=$(terraform -chdir=infra/serverless output -raw discord_hello_function_uri)
printf 'Callback Discord dev : %s/discord/interactions\n' "$GATEWAY_URL"
```

Le backend dev est le bucket `cloud-pixelwar-eliottmth-dev-tfstate`, préfixe
`serverless`. Ne pas utiliser le backend prd ni changer de workspace. Ces
commandes initialisent le client local et lisent le state ; elles ne déploient
pas de ressource. Si un output est absent, vide ou nul, arrêter et vérifier le
run, le commit et le backend.

Deux vérifications HTTP, sans token ni signature :

```sh
# Attendu : 401 du handler, atteint à travers la gateway.
curl --include --max-time 10 --request POST \
  --header 'Content-Type: application/json' --data '{"type":1}' \
  "$GATEWAY_URL/discord/interactions"

# Attendu : refus IAM direct (403 attendu), sans exécution du handler.
curl --include --max-time 10 --request POST \
  --header 'Content-Type: application/json' --data '{"type":1}' \
  "$FUNCTION_URL/discord/interactions"
```

Le premier appel peut réchauffer l'instance. La validation suivante du portail
ne doit donc pas être présentée comme une mesure de démarrage à froid ; faire
ensuite l'essai distinct décrit dans la section de mesure.

## Vérifier le callback, avant d'ajouter `/hello`

Après réussite du déploiement dev, récupérer les outputs `gateway_url` et
`discord_hello_function_uri` du stack serverless via la procédure habituelle.
L'endpoint Discord est **`<gateway_url>/discord/interactions`**, et non `/hello`.

1. Vérifier avec une requête POST JSON non signée que la gateway atteint bien le
   handler : réponse **401** attendue.
2. Vérifier qu'un appel direct **anonyme** à l'URL backend (avec le chemin
   `/discord/interactions`) est refusé par IAM, sans exécuter le handler.
3. Après validation, ouvrir l'application **dev** dans Discord Developer Portal,
   relever son éventuelle ancienne URL d'interactions, puis renseigner l'endpoint
   gateway dans **Interactions Endpoint URL** et enregistrer.
4. Discord envoie lui-même un `PING` signé et des contrôles de signature. Le portail
   doit accepter l'URL ; le handler doit renvoyer un PONG uniquement aux requêtes
   valablement signées. Aucun token Firebase n'est nécessaire sur cette route.

On ne détient pas la clé privée de Discord : un `curl` fabriqué ne peut pas prouver
une signature Discord réelle. Les tests locaux utilisent une paire de clés de test.

## Ajouter `/hello nom` sans écraser le catalogue

Dans `app/`, avec Node.js 24 et les dépendances installées, charger les variables
dans le même terminal. Ne pas activer `set -x` et ne pas afficher le token :

```sh
set +x
export APP_ENV=dev
export DISCORD_GUILD_ID='ID_DU_SERVEUR_DE_TEST'
DISCORD_APPLICATION_ID=$(gcloud secrets versions access 1 \
  --secret=discord-application-id --project=cloud-pixelwar-dev) || exit 1
export DISCORD_APPLICATION_ID

# Dry-run : aucun appel Discord, aucun token de bot nécessaire.
npm run discord:commands -- --hello
```

Vérifier l'application, la guild et **`method: POST`**, avec une seule commande
`hello` et l'option string obligatoire `nom`. Après confirmation de la cible et
validation de la modification Discord :

```sh
DISCORD_BOT_TOKEN=$(gcloud secrets versions access 1 \
  --secret=discord-bot-token --project=cloud-pixelwar-dev) || exit 1
export DISCORD_BOT_TOKEN
npm run discord:commands -- --hello --apply \
  --confirm-application-id "$DISCORD_APPLICATION_ID"
unset DISCORD_BOT_TOKEN DISCORD_APPLICATION_ID DISCORD_GUILD_ID APP_ENV
```

Ce mode crée/met à jour uniquement `/hello` dans la guild dev. Il refuse prd et
n'utilise **pas** le bulk overwrite du catalogue métier. Ne pas lancer le mode
habituel sans `--hello` pendant l'essai : il remplacerait le catalogue et retirerait
la commande temporaire (ainsi que toute autre commande non listée).

Dans le serveur de test, lancer `/hello nom:Benjamin`, puis un nom accentué ou
composé. Vérifier le texte exact `Hello Benjamin !` et la réception du paramètre.

## Mesurer le délai et le démarrage à froid

La fonction démarre avec `min_instances = 0`, `max_instances = 2`. Ne pas mettre
d'instance chaude avant le premier essai : cela masquerait le cold start recherché.

- Le log `handler_ms` ne mesure que le handler, **pas** le démarrage du conteneur,
  le transit réseau ni le traitement de la gateway.
- `first_request=true` identifie le premier appel de cette instance, y compris
  un appel rejeté ; ce n'est pas à lui seul une preuve de cold start complet.
- Confronter l'acceptation du callback par Discord et les essais `/hello` aux logs
  de requête/latences Gateway et Cloud Run ; relever premier appel et appels suivants.
- Une validation du portail ou un essai rapide ne garantit pas tous les cold starts.
  Répéter après retour à zéro et vérifier les journaux d'instance ; ne pas envoyer
  une sonde HTTP préalable qui réchaufferait l'instance.
- Discord doit recevoir la réponse en moins de trois secondes. Si le premier appel
  échoue, examiner build, IAM, signature, routage et latences avant de modifier les
  limites. Le deadline Gateway de 3 s n'est pas un délai supplémentaire accordé par
  Discord.

## Retrait après validation

Après validation explicite : retirer uniquement la commande guild `/hello` via
son ID Discord (ne pas vider le catalogue), restaurer/mettre à jour le callback dev
avant de supprimer sa fonction, puis mettre `enable_discord_hello = false` et
appliquer en dev par la pipeline. Si aucune autre fonction n'est branchée, la
gateway temporaire sera également supprimée. Conserver les résultats de l'essai
dans les tickets, sans secrets ni tokens d'interaction.

## Contrôles locaux sans GCP ou Discord

```sh
cd app
npm ci
npm run typecheck
npm run test:coverage
npm run build:functions
cd ../infra/serverless
terraform init -backend=false
terraform validate
terraform test
```

Les tests comprennent signatures valides/invalides, corps brut, PING, paramètre,
mentions, erreurs, garde dev/prd et un serveur HTTP de test du vrai Functions Framework.
Leurs clés Ed25519 sont éphémères et ne proviennent jamais de Discord.

Le workflow de destroy serverless construit lui aussi les fonctions : Terraform
rafraîchit `archive_file` pendant la préparation du destroy, même si l'archive sert
à une ressource à supprimer. Sans `dist/` sur un runner neuf, le destroy échouerait
avant toute suppression.
