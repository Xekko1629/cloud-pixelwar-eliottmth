# Stack frontend

Service Cloud Run `frontend` : une image nginx non root qui sert l'application
React de `app/frontend` ([ADR-0011](../../docs/adr/0011-frontend-image-cloud-run.md)).

## Dépendances

- `bootstrap` : dépôt Artifact Registry `pixelwar` (l'image y est poussée sous
  `frontend`, avec la même politique de rétention que les images des fonctions).
- `gateway` : ce stack lit `gateway_url` dans son state. Il est donc appliqué
  **après** `gateway`, et détruit avant. Tant que la gateway ne publie aucun proxy
  (prd aujourd'hui), l'URL de l'API est vide et la page l'indique.

## Image

- `app/frontend/Dockerfile`, contexte `app/` : build Vite dans `node:24`, puis
  `nginxinc/nginx-unprivileged` (utilisateur 101, port 8080). Les deux images de
  base sont épinglées par digest.
- La CI (`.github/workflows/_frontend-image.yml`) construit l'image **une fois
  par commit**, sous forme d'archive OCI aux horodatages reproductibles, et teste
  le conteneur : `/config.js`, repli SPA, en-têtes, cache, refus d'une
  configuration invalide.
- Chaque apply pousse cette même archive dans le dépôt de son environnement avec
  `skopeo copy --preserve-digests`, vérifie le digest poussé, puis le passe à
  Terraform (`TF_VAR_image`). Dev et prd exécutent donc le même digest.
  Terraform refuse une image référencée par tag ou venant d'un autre projet.

## Configuration

L'image ne contient aucune valeur d'environnement. Au démarrage,
`05-check-config.envsh` vérifie les variables du service, puis le template nginx
génère `/config.js` :

| Variable | Source | Contrainte |
| --- | --- | --- |
| `APP_ENV` | `environment` | `dev` ou `prd` |
| `GATEWAY_URL` | output `gateway_url` du stack `gateway` | origine https, ou vide |
| `FIRESTORE_PROJECT_ID` | `project_id` | id de projet GCP |
| `FIRESTORE_API_KEY` | variable `firestore_api_key` (DRAW-03a, ADR-0015) | clé d'API Google, ou vide |
| `DISCORD_CLIENT_ID` | variable `discord_client_id` (WEB-02b) | snowflake Discord, ou vide |

Une valeur invalide arrête le conteneur : la révision Cloud Run ne démarre pas, au
lieu de servir une configuration cassée ou injectable. Ces valeurs sont publiques ;
aucun secret ne passe par ce stack.

## Sécurité

- Compte de service `frontend` **sans aucun rôle**.
- `roles/run.invoker` pour `allUsers` sur ce service uniquement : c'est la seule
  exception publique acceptée (ADR-0011, ADR-0015), listée par SEC-01. Le service
  ne relaie aucune API : tous les appels passent par la gateway, sauf les
  listeners Firestore en lecture seule (ADR-0015).
- En-têtes : `Content-Security-Policy` limitée à la gateway, à Firestore
  (`https://firestore.googleapis.com`) et aux avatars Discord, `Strict-Transport-Security`, `X-Content-Type-Options`,
  `Referrer-Policy`, version de nginx masquée.

## Vérification

```sh
terraform -chdir=infra/frontend test
terraform -chdir=infra/frontend output frontend_url
terraform -chdir=infra/frontend output discord_redirect_uri   # à enregistrer dans l'application Discord
curl -s "$(terraform -chdir=infra/frontend output -raw frontend_url)/config.js"
```

En local, `npm run dev --workspace=@pixelwar/frontend` (dans `app/`) sert l'application
avec un `/config.js` construit depuis `GATEWAY_URL`, `FIRESTORE_PROJECT_ID`,
`FIRESTORE_API_KEY` et `DISCORD_CLIENT_ID` du shell.

## Destroy

`destroy` supprime le service, son binding public et le compte de service. Les
images restent dans le dépôt du bootstrap, qui n'est jamais détruit.
