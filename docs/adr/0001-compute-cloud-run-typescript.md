# ADR-0001 · Compute : services Cloud Run, en TypeScript sur Node.js 24

- **Statut** : Accepté
- **Date** : 2026-10-23
- **Tickets** : ARCH-01 (#26). Débloque TEST-01, SRV-01, SRV-02, SRV-08, DATA-01, DATA-03 ; lié à FND-06c.
- **Références** : Sujet §3.1, §5.5 · C05 §1-2 · C06 §1-2

## Contexte

- L'application doit être 100 % serverless et suivre le principe de responsabilité unique : un service par tâche, chacun avec son propre service account (§3.1).
- GCP propose deux façons de déployer ce code, qui tournent toutes les deux sur Cloud Run (scale à zéro, facturation à l'usage) :
  - les **services Cloud Run** : on fournit une image de conteneur ;
  - les **Cloud Run functions** (ex-Cloud Functions gen2) : on fournit les sources, et Cloud Build construit l'image au moment du déploiement.
- SRV-02 exige qu'une release construise chaque image **une seule fois**, puis déploie le même digest en dev et en prd.
- Le frontend tourne dans le navigateur : il sera de toute façon en TypeScript ou en JavaScript.
- Chaque membre doit pouvoir expliquer tout le code à la soutenance, pas seulement sa partie (§5, §5.5).

## Décision

### Compute

Tous les proxies et workers sont des **services Cloud Run**, déployés par Terraform à partir d'une image (module `service`, SRV-01).

- `min_instances = 0` par défaut, `max_instances` plafonné pour chaque service. Seule exception envisagée : `discord-proxy` à 1 instance en prd, si le cold start menace le délai de 3 s de Discord (BOT-03).
- Ingress des **proxies** (`discord-proxy`, `web-proxy`, `auth-proxy`) : `INGRESS_TRAFFIC_ALL`, car API Gateway les appelle depuis l'extérieur du projet. Ils restent privés grâce à l'IAM : seul le service account de la gateway a `run.invoker` sur eux.
- Ingress des **workers** : `INGRESS_TRAFFIC_INTERNAL_ONLY`. D'après la documentation de Cloud Run, Pub/Sub et Cloud Scheduler du même projet passent encore (via l'URL `run.app`), mais Internet est bloqué avant même la vérification IAM.
- Un service account par service, et aucun binding `allUsers`.

### Langage et runtime

- **TypeScript** en mode `strict`, sur **Node.js 24 LTS** (maintenu jusqu'en avril 2028), pour les services comme pour le frontend.
- Un seul espace de travail npm (*workspaces*) dans `app/`. Les noms exacts se figent dans SRV-01 et TEST-01 :

  ```
  app/
  ├── package.json          # workspaces npm
  ├── shared/               # enveloppe des événements (ARCH-03), palette et maths des tuiles (ADR-0007),
  │                         # logger et OpenTelemetry (SRV-08)
  ├── functions/<service>/  # un dossier par service Cloud Run
  └── frontend/
  ```

- Bibliothèques de base, à justifier dans SEC-02 : `firebase-admin` (Firestore et custom tokens), `@google-cloud/pubsub`, `@google-cloud/storage`, le SDK OpenTelemetry et les exporteurs Google Cloud.
- La signature Ed25519 de Discord se vérifie avec `node:crypto`, sans dépendance supplémentaire.
- Le framework de tests se choisit dans TEST-01. Vitest est un candidat naturel avec TypeScript.

## Options écartées

| Option | Pourquoi elle est écartée |
|---|---|
| Cloud Run functions (gen2) | L'image est reconstruite à chaque déploiement, dans chaque environnement : dev et prd n'exécutent pas le même artefact, ce qui contredit SRV-02. Le build a lieu pendant `terraform apply` (Cloud Build), ce qui rallonge l'apply et le rend plus fragile. Leur seul avantage, ne pas gérer le build, est traité par FND-06c. |
| Python 3.13 | Pillow est excellent pour le rendu d'images. Mais le projet aurait deux langages (Python pour le backend, TypeScript pour le frontend), et le code commun (palette, bornes de la grille, découpage en tuiles, format des événements) serait écrit et testé deux fois. Les cold starts sont aussi plus lents. |
| Go | Meilleurs cold starts, et un rendu d'image très efficace avec la bibliothèque standard (`image/png`, `crypto/ed25519`). Mais là aussi deux langages, sans code partagé, et un langage de plus que les trois membres doivent maîtriser pour la soutenance. |
| GKE ou VM | Interdit : le cluster n'héberge que les runners de CI (§3.1). |

## Conséquences

**Ce qu'on y gagne**

- Un seul langage à maîtriser pour toute l'équipe, du navigateur aux workers.
- Les règles communes (bornes de la grille, palette, tuiles et régions, validation d'un lot de pixels) n'existent qu'une fois. Elles sont testées une fois, puis utilisées par le frontend, les proxies et les workers.
- Un seul artefact par service et par release, promu de dev à prd.
- Les workers sont injoignables depuis Internet, ce qui ajoute une défense en profondeur à l'IAM.

**Ce que ça coûte, et ce qu'il faut surveiller**

- Il faut construire et publier les images : c'est l'objet de FND-06c et de SRV-02.
- Node est moins économe en mémoire que Go pour rendre une grande image : 10000×10000 pixels en RGBA font 400 Mo. Le rendu (DATA-05b) passera par une bibliothèque native (par exemple `sharp`, basée sur libvips) ou par un buffer indexé à 1 octet par pixel, et le `render-worker` aura une mémoire dimensionnée à part.
- Le cold start de Node grossit avec les dépendances (`firebase-admin` surtout) : garder des images minces, et mesurer le temps d'acquittement du `discord-proxy` (BOT-09).

## En soutenance

- « Des services Cloud Run plutôt que des functions : on construit l'image une seule fois et on déploie exactement le même digest en dev puis en prd. »
- « TypeScript partout : le frontend l'impose, et ça nous permet de partager la palette, les calculs de tuiles et le format des événements entre le navigateur et les workers. »
- « Les workers sont en ingress interne : même avec un token, on ne peut pas les appeler depuis Internet. Seuls Pub/Sub et Cloud Scheduler les atteignent. »
