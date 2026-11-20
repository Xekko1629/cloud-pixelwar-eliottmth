# ADR-0012 · Identité web : OAuth2 Discord, puis JWT de session signé par un compte de service

- **Statut** : Accepté (demandé à la revue intermédiaire)
- **Date** : 2026-11-19
- **Tickets** : SRV-04c (#34), WEB-02a (#59), WEB-02b (#60), DRAW-01 (#58), DATA-03 (#42). Remplace [ADR-0005](0005-identite-web-firebase-auth.md).
- **Références** : Sujet §3.4 · C05 §3 · C07 §3.2 · [signJwt](https://cloud.google.com/iam/docs/reference/credentials/rest/v1/projects.serviceAccounts/signJwt) · [API Gateway : authentification par compte de service](https://cloud.google.com/api-gateway/docs/authenticate-service-account)

## Contexte

- La revue intermédiaire exclut Firebase. L'ADR-0005 reposait sur un custom token
  Firebase échangé contre un ID token Firebase, vérifié par la gateway et par les
  règles Firestore.
- Les contraintes de l'ADR-0005 restent : connexion Discord OAuth2 avec le scope
  `identify`, token Discord jamais conservé, authentification **à la gateway**,
  même identité (id Discord) depuis le web et depuis Discord.
- API Gateway valide n'importe quel JWT dont il connaît l'émetteur et l'URL des
  clés publiques (`x-google-issuer`, `x-google-jwks_uri`).
- Sans Firebase, le navigateur ne lit plus Firestore directement
  ([ADR-0013](0013-lectures-temps-reel-sans-firebase.md)) : le token n'a plus
  besoin d'être compris par les règles Firestore.

## Décision

### Émetteur

- Un compte de service dédié **`session-signer`** (`infra/serverless/session.tf`)
  signe les JWT de session. Il n'a aucun rôle et n'exécute aucun code.
- L'`auth-proxy` signe par l'API IAM Credentials **`signJwt`** sur ce compte. Son
  identité d'exécution reçoit `roles/iam.serviceAccountTokenCreator` sur
  `session-signer` uniquement (WEB-02a).
- Google détient et fait tourner les clés privées. Les clés publiques sont
  publiées à `https://www.googleapis.com/robot/v1/metadata/x509/<email>`.
  Aucune clé n'existe dans le dépôt, Secret Manager ou un state Terraform.

### Flux

1. `GET /auth/login` : l'`auth-proxy` renvoie l'URL d'autorisation Discord
   (scope `identify`) et un `state` signé (HMAC, quelques minutes). Inchangé.
2. Discord redirige vers `https://<frontend>/auth/callback?code=…&state=…`.
3. Le frontend vérifie son `state`, puis appelle `POST /auth/exchange { code, state }`.
4. L'`auth-proxy` vérifie le `state`, échange le code, lit `GET /users/@me`,
   **jette le token Discord**, puis signe le JWT de session :

   | Claim | Valeur |
   |---|---|
   | `iss` | e-mail de `session-signer` |
   | `aud` | id du projet GCP (un token de dev est refusé en prd) |
   | `sub` | id Discord |
   | `name` | pseudo Discord |
   | `iat`, `exp` | durée de vie de 1 h |
   | `auth_time` | date de la connexion Discord |

5. Le frontend garde le JWT en mémoire (et en `sessionStorage` pour survivre à un
   rechargement), puis l'envoie dans `Authorization: Bearer` à chaque appel `/api/*`.
6. La gateway valide signature, émetteur, audience et expiration (définition
   `session` du module `api-gateway`), répond 401 sans invoquer la fonction
   sinon, et transmet les claims au proxy dans `X-Apigateway-Api-Userinfo`.
7. Renouvellement : `POST /api/session/refresh`, protégé par la gateway, émet un
   nouveau JWT tant que `auth_time` a moins de 12 h. Au-delà, l'utilisateur se
   reconnecte avec Discord.

## Options écartées

| Option | Pourquoi elle est écartée |
|---|---|
| Custom token et ID token Firebase (ADR-0005) | Firebase est exclu par la revue intermédiaire. |
| Identity Platform | C'est Firebase Authentication sous un autre nom, et Discord n'y est pas un fournisseur intégré. |
| Clé de signature propre, stockée dans Secret Manager | Il faudrait publier nous-mêmes une JWKS et gérer la rotation ; une fuite de la clé permet de forger n'importe quelle identité. |
| Transmettre le token Discord à chaque appel | La gateway ne valide pas un token opaque, et le token Discord circulerait dans tout le backend. |
| Cookie de session côté serveur | Frontend et gateway sur deux domaines différents : cookie tiers bloqué par les navigateurs, et état de session à stocker. |

## Conséquences

- Aucun produit Firebase ni API `identitytoolkit` à activer (`infra/iam/apis.tf`).
- Pas de révocation individuelle avant expiration : la durée de vie courte (1 h)
  limite l'exposition. Une révocation d'urgence se fait en supprimant les clés du
  compte `session-signer`, ce qui invalide toutes les sessions.
- `signJwt` a un quota par projet : un appel par connexion et par
  renouvellement, très en dessous pour la démonstration.
- Le service temps réel (ADR-0013) valide le même JWT avec les mêmes clés
  publiques, dans son code.
- Tests à écrire (WEB-02a) : `state` absent, expiré ou modifié refusé ; claims
  attendus ; token Discord absent des logs et des réponses ; JWT d'un autre
  projet refusé.
