# ADR-0005 · Identité web : OAuth2 Discord côté serveur, puis custom token Firebase

- **Statut** : Accepté
- **Date** : 2026-10-23
- **Tickets** : ARCH-01 (#26). Utilisé par SRV-04c, SRV-06, DRAW-01, WEB-02a, WEB-02b, DATA-03.
- **Références** : Sujet §3.4 · C05 §3, §6 · C07 §3.2

## Contexte

- Les utilisateurs se connectent avec Discord OAuth2, avec des scopes minimaux, et on ne garde pas leur token Discord côté serveur (§3.4, C07 §3.2).
- Les appels du frontend sont authentifiés **à la gateway** (C05 §3). GCP API Gateway sait valider un JWT, mais pas un token opaque comme le token d'accès Discord.
- Les lectures directes dans Firestore (ADR-0003, ADR-0004) doivent être authentifiées par les **règles Firestore**, qui ne connaissent que l'authentification Firebase.
- Un même utilisateur dessine depuis Discord et depuis le web : son quota (DATA-03) et sa signature sur les pixels doivent être les mêmes des deux côtés.

## Décision

Un `auth-proxy` derrière la gateway échange le code OAuth2 de Discord, jette le token Discord, et émet un **custom token Firebase**. Le navigateur l'échange contre un **ID token Firebase**, et c'est ce même ID token qui est vérifié par la gateway et par les règles Firestore.

### Le flux

1. Le frontend appelle `GET /auth/login` via la gateway. L'`auth-proxy` renvoie l'URL d'autorisation Discord (scope `identify` uniquement) et un `state` signé (HMAC) qui expire après quelques minutes. Le frontend garde ce `state` en `sessionStorage`, puis redirige vers Discord.
2. Discord redirige vers le frontend (`/auth/callback?code=…&state=…`), sur une redirect URI enregistrée à l'identique dans l'application Discord.
3. Le frontend vérifie que le `state` reçu est bien le sien, puis envoie `POST /auth/exchange { code, state }` via la gateway.
4. L'`auth-proxy` :
   - vérifie la signature et l'expiration du `state` ;
   - échange le code contre un token Discord, avec le client secret lu dans Secret Manager ;
   - lit l'identité de l'utilisateur (`GET /users/@me`) ;
   - **jette le token Discord** : il ne le stocke pas et ne le logge pas ;
   - crée un custom token Firebase avec `uid` = **id Discord** et une claim `name` (le pseudo). Il le signe sans clé, par `signBlob`, ce qui demande `iam.serviceAccountTokenCreator` sur son propre service account (WEB-02a).
5. Le frontend appelle `signInWithCustomToken`, et obtient un ID token Firebase valable 1 h, que le SDK renouvelle tout seul.
6. Chaque appel à `/api/*` porte `Authorization: Bearer <ID token>`. La gateway le valide (`securityDefinitions` Firebase : émetteur `https://securetoken.google.com/<project>`, audience `<project>`), puis transmet les claims au proxy dans l'en-tête `X-Apigateway-Api-Userinfo`, encodé en base64url (DRAW-01).
7. Les listeners Firestore utilisent automatiquement la même session : les règles lisent `request.auth.uid`.

Routes `/auth/*` : pas de `security` à la gateway, puisque l'utilisateur n'a pas encore de token. Les routes `OPTIONS` du préflight CORS restent sans `security` (SRV-04c).

### Pourquoi `uid` = id Discord

Un pixel posé depuis Discord et un pixel posé depuis le web ont le même auteur, comptent dans le même quota, et la même allow-list d'admins s'applique. Il n'y a aucune table de correspondance à maintenir.

## Options écartées

| Option | Pourquoi elle est écartée |
|---|---|
| Notre propre JWT, signé par l'`auth-proxy` | La gateway pourrait le valider, à condition de publier nous-mêmes une JWKS et de gérer la rotation des clés. Mais les règles Firestore ne l'acceptent pas : les lectures directes (ADR-0004) deviendraient impossibles. |
| Transmettre le token Discord à chaque appel | La gateway ne sait pas valider un token opaque. Chaque proxy devrait interroger l'API Discord à chaque requête, ce qui ajoute de la latence et expose à leurs limites de débit. Et le token Discord circulerait dans notre backend à chaque appel. |
| Session par cookie, stockée côté serveur | Il faudrait un état de session en base. Le frontend et la gateway ne sont pas sur le même domaine, donc ce serait un cookie tiers, bloqué par les navigateurs récents. Et les règles Firestore ne le connaissent pas. |
| Connexion Discord gérée directement par Firebase Auth ou Identity Platform | Discord ne fait pas partie de leurs fournisseurs intégrés. Il faudrait de toute façon un échange côté serveur pour garder le client secret hors du navigateur : c'est exactement ce que fait l'`auth-proxy`. |

## Conséquences

**Ce qu'on y gagne**

- Un seul token pour tout : la gateway pour les écritures, les règles Firestore pour les lectures.
- Le token Discord ne vit que le temps d'une requête, dans la mémoire de l'`auth-proxy`.
- Le scope demandé est le minimum : `identify`.

**Ce que ça coûte, et ce qu'il faut surveiller**

- Firebase doit être activé sur chaque projet, ainsi que l'API `identitytoolkit.googleapis.com`. Une fois ajouté, Firebase ne peut plus être retiré d'un projet (documentation du provider `google_firebase_project`) : il va dans le stack `bootstrap` (BOOT-05), pas dans `serverless`. Il n'y a pas de fournisseur d'identité à configurer, les custom tokens n'en ont pas besoin : à confirmer pendant WEB-02a.
- La clé d'API web de Firebase est publique, car elle est dans le bundle. On la restreint aux domaines du frontend et aux seules APIs nécessaires (Identity Toolkit, Secure Token, Firestore).
- Dev et prd sont deux projets Firebase distincts : un token de dev est refusé en prd, puisque l'audience est le project id.
- Le `refresh token` de Firebase reste dans le navigateur (géré par le SDK). Ce n'est pas un token Discord : on respecte bien la règle du sujet.
- Tests à écrire (WEB-02a) : `state` absent, expiré ou modifié refusé ; le token Discord n'apparaît ni dans les logs, ni dans la réponse.

## En soutenance

- « On ne garde jamais le token Discord : l'`auth-proxy` s'en sert une seule fois pour lire l'id de l'utilisateur, puis émet un custom token Firebase. »
- « Le même ID token Firebase est vérifié par API Gateway pour écrire, et par les règles Firestore pour lire. »
- « L'uid Firebase est l'id Discord : le quota et l'auteur d'un pixel sont les mêmes depuis Discord et depuis le web. »
