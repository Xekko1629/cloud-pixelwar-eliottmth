# frontend

Site web de Pixel War : React, Vite et canvas, servi par nginx sur Cloud Run
([ADR-0011](../../docs/adr/0011-frontend-image-cloud-run.md)). La configuration de
l'environnement (`gatewayUrl`, Firestore, id Discord) est lue au démarrage dans
`/config.js` (`src/config.ts`) : la même image tourne en dev et en prd.

## Connexion Discord (WEB-02b)

Flux décrit par [ADR-0012](../../docs/adr/0012-identite-web-jwt-session.md) et le
contrat de [`auth-proxy`](../functions/auth-proxy/README.md) :

1. « Se connecter avec Discord » appelle `GET /auth/login`, garde `state` et son
   expiration en `sessionStorage`, puis redirige vers Discord.
2. Au retour sur `/auth/callback?code&state`, le `state` reçu doit être celui gardé
   par **cet onglet** et ne pas avoir expiré ; sinon la gateway n'est pas appelée.
   Le code et le `state` sont retirés de la barre d'adresse, puis échangés par
   `POST /auth/exchange`, une seule fois même sous `StrictMode`.
3. Le JWT de session (15 min) est gardé en mémoire et en `sessionStorage` (il
   survit à un rechargement, pas à la fermeture de l'onglet). Le token Discord ne
   passe jamais par le navigateur.
4. Un minuteur appelle `POST /api/session/refresh` cinq minutes avant `expires_at`.
   Un refus (`401`, connexion Discord de plus de 12 h) déconnecte avec un message ;
   une panne réseau garde la session et réessaie une minute plus tard.
5. « Se déconnecter » efface la session locale. Le JWT est sans état : une copie prise
   ailleurs resterait valable jusqu'à son expiration (15 min au plus).

| Fichier | Rôle |
| --- | --- |
| `src/api/client.ts` | **Seul client HTTP vers la gateway** : `Authorization: Bearer`, renouvellement avant expiration (une seule requête pour des appels simultanés), `401` qui termine la session, `ApiError { status, code }`. `304` rendu à l'appelant pour les `ETag` des tuiles. |
| `src/auth/session.ts` | Validation de la réponse de session, stockage mémoire et `sessionStorage` (tolère un stockage bloqué). |
| `src/auth/auth.ts` | Connexion, retour de Discord, déconnexion, minuteur de renouvellement, états affichés. |
| `src/auth/AuthControls.tsx` | Bouton, pseudo connecté, messages d'erreur dans l'en-tête. |

Les tuiles (WEB-03b), l'inspection (WEB-04) et le brush (WEB-05) passent par
`services.api` (`src/auth/setup.ts`), jamais par `fetch` directement.

## Développement local

```sh
cd app/frontend
GATEWAY_URL=https://pixelwar-7prj1syc.ew.gateway.dev npx vite
```

Le CORS de la gateway n'accepte que l'origine Cloud Run. En local, la page appelle sa
propre origine et Vite relaie `/auth/login`, `/auth/exchange` et `/api/*` vers
`GATEWAY_URL`, sans en-tête `Origin` : aucune modification d'infrastructure.

Limite : l'`auth-proxy` envoie toujours à Discord la redirection
`<FRONTEND_ORIGIN>/auth/callback` (l'URL Cloud Run), et l'échange doit utiliser la même.
Après l'autorisation, Discord renvoie donc vers le frontend Cloud Run, pas vers
`localhost` : la connexion complète ne se teste que sur l'environnement déployé. En
local, on vérifie le bouton, l'appel à `/auth/login` et les routes protégées (`401`).
