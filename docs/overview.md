# Vue éloignée : pyramide d'images (DATA-05c)

## Rôle

La grille est infinie ([ADR-0007](adr/0007-modele-donnees-grille.md)) : en vue éloignée,
l'écran couvre des milliers de tuiles. Le frontend affiche alors des images basse
résolution, comme une carte en ligne (WEB-03d), et applique les deltas en direct par-dessus.

| Niveau | Une image de 256 × 256 couvre | Échelle | Objet du bucket `overview` |
| --- | --- | --- | --- |
| 1 | 1 région (1024 × 1024 pixels) | 1 pixel d'image pour 4 × 4 | `v<version>/1/<rx>_<ry>.png` |
| 2 | 4 × 4 régions (4096 × 4096) | 1 pour 16 × 16 | `v<version>/2/<cx>_<cy>.png` |
| 3 | 16 × 16 régions (16 384 × 16 384) | 1 pour 64 × 64 | `v<version>/3/<cx>_<cy>.png` |

Une image n'existe que là où quelque chose est peint : une image absente est une zone
vide. Les pixels jamais peints sont blancs, comme pour `/get`. Quand plusieurs pixels
tombent dans un même pixel d'image, une couleur l'emporte sur le blanc : un trait fin
reste visible au dézoom. La géométrie est dans `app/shared/src/overview/`.

## `overview-worker`

Cloud Scheduler publie chaque minute sur `overview-tick` (`var.overview_schedule`) ; un
abonnement push OIDC appelle le worker (`app/functions/overview-worker`,
`infra/serverless/overview-path.tf`). Un cycle :

1. Lit `config/global` et son état `state.json` dans le bucket : version de la toile,
   début du cycle précédent (curseur) et régions restant à traiter.
2. Trouve les régions modifiées dans les **deltas** créés depuis 5 minutes avant le
   curseur. Ce recouvrement rattrape une transaction lente (jusqu'à 270 s) qui a daté
   son delta avant de le valider. Re-rendre une région deux fois ne change rien.
   Les régions ne viennent pas d'un consommateur de `pixel-processed`, qui coûterait
   une invocation par pixel (décision du 26/11, option B).
3. **Reconstruit tout** sans état, après un changement de version (`/admin clear`, et
   les images de l'ancienne version sont supprimées) ou si le curseur a plus de
   50 minutes (les deltas expirent au bout d'une heure). Les régions viennent alors
   des tuiles existantes, jamais du rectangle `bounds` : deux pixels très éloignés ne
   produisent pas des millions d'images vides.
4. Rend le niveau 1 de chaque région depuis ses tuiles (`canvas_version` + `region`,
   index existant), puis les niveaux 2 et 3 concernés depuis les images du niveau
   inférieur relues dans le bucket (`decodeIndexedPng`, limité à notre format PNG).
   Une zone redevenue vide supprime son image.
5. Traite **au plus 64 régions par cycle** ; le reste passe dans `pending`, toujours
   dans le même ordre, pour le cycle suivant.
6. Écrit l'état en dernier, avec une précondition sur sa génération. Un cycle qui
   échoue à mi-chemin est refait par le tick suivant. Deux cycles simultanés : le
   premier qui écrit gagne, l'autre acquitte son tick.

Profil : 1 instance au plus, une requête à la fois, 512 Mio, 300 s, délai
d'acquittement de 330 s. Un tick de plus de 2 minutes est acquitté sans travail.

| `event_type` | Sévérité | Quand |
| --- | --- | --- |
| `overview.cycle.done` | INFO | Cycle terminé : `mode` (`full` ou `incremental`), images rendues par niveau, supprimées, régions en attente, durée |
| `overview.tick.stale` | INFO | Tick trop ancien, acquitté sans travail |
| `overview.cycle.concurrent` | WARNING | Un autre cycle a écrit l'état en premier |
| `overview.cycle.failed` | ERROR | Cycle à refaire (`503`) ; `reason = stored_data` si une donnée stockée est invalide |
| `overview.message.invalid` | WARNING | Enveloppe push invalide (`400`, puis DLQ) |

## Lecture par le frontend

`GET /api/overview/{niveau}/{cx}/{cy}` sur le `tile-reader`, derrière la gateway et
la session, renvoie une URL signée de 15 minutes ([tile-reader.md](tile-reader.md)).
Le navigateur charge ensuite l'image directement depuis Cloud Storage. Le bucket reste
privé (`public_access_prevention = enforced`) ; son CORS n'autorise que `GET` depuis
l'origine du frontend. Les images portent `Cache-Control: private, max-age=60`.

## Droits

| Identité | Rôle | Portée |
| --- | --- | --- |
| `overview-worker` | `roles/datastore.viewer` | Projet (lecture de `config/global`, `deltas`, `tile_colors`) |
| `overview-worker` | `roles/storage.objectAdmin` | Bucket `overview` seulement (images et `state.json`) |
| `tile-reader` | `roles/storage.objectViewer` | Bucket `overview` seulement |
| `tile-reader` | `roles/iam.serviceAccountTokenCreator` | Son propre compte : signature `signBlob` sans clé |
| Agent Cloud Scheduler | `roles/pubsub.publisher` | Topic `overview-tick` seulement |

Le curseur est dans le bucket et non dans Firestore : le worker n'a aucun droit
d'écriture sur Firestore.

## Activer en dev

`enable_overview = true` dans `infra/serverless/dev.tfvars` ; il faut aussi
`enable_web_api` et la livraison `/draw`. Vérifications après le deploy :

1. Logs `overview.cycle.done` chaque minute ; le premier en `mode: full`.
2. Objets `v<version>/1/…`, `/2/…` et `/3/…` dans le bucket `overview`, là où l'on a
   dessiné, et `state.json`.
3. Un dessin, puis au cycle suivant un `mode: incremental` avec `rendered["1"] = 1`.
4. `GET /api/overview/1/<rx>/<ry>` avec la session : l'URL s'ouvre et montre l'image ;
   la même URL modifiée (signature) est refusée.
5. `/admin clear` : un cycle `full` sur la nouvelle version, plus aucun objet `v<ancienne>/`.

## Tests

```sh
npx vitest run functions/overview-worker shared/src/overview shared/src/render
npm run test:integration   # dont functions/overview-worker/src/store.integration.test.ts
```

Le test sur émulateur écrit de vrais dessins avec DATA-02, puis lance un cycle qui relit
les vrais deltas et tuiles. Le bucket y est simulé en mémoire : signature, CORS et
préconditions réelles de Cloud Storage restent à vérifier en dev.
