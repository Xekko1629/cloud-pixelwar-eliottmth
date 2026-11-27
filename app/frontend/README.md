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

## Tuiles (WEB-03b)

Contrat : [`tile-reader`](../../docs/tile-reader.md). La toile est découpée en régions
de 1024 × 1024 pixels (16 × 16 tuiles), chargées par `GET /api/regions/{rx}/{ry}/tiles`.

- **Seules les régions visibles sont demandées**, une fois chacune, dès qu'elles entrent
  dans l'écran (`src/canvas/region-tiles.ts`). Au plus 48 régions restent en mémoire :
  au-delà, la région affichée le moins récemment et sortie de l'écran est libérée.
- **La toile demande une connexion.** Ses tuiles viennent de l'API, et le sujet exige
  que tout appel du frontend à l'API soit authentifié (§3.4). Sans session, la toile
  ne montrerait que les pixels posés depuis l'ouverture de la page, pas l'état à jour :
  elle est remplacée par une invitation à se connecter. Les tuiles se chargent à la
  connexion et sont oubliées à la déconnexion. Pour l'ouvrir aux visiteurs plus tard,
  il suffirait d'un autre `RegionFetcher` (par exemple une lecture Firestore de
  `tile_colors` autorisée par les Security Rules, ce qui amenderait ADR-0015).
- **Cache HTTP** : `cache: 'no-cache'` laisse le navigateur garder la réponse et la
  revalider avec son `ETag`. Une région inchangée coûte un `304` sans corps. Le
  frontend n'envoie pas `If-None-Match` lui-même : cet en-tête n'est pas « sûr » pour
  CORS, et le preflight de `tile-reader` n'autorise que `Authorization`.
- **Deltas pendant le chargement** : la réponse peut être plus ancienne qu'un pixel
  reçu en temps réel pendant la requête. Ces pixels sont gardés, puis repeints sur
  les tuiles chargées, dans l'ordre (`src/realtime/live.ts`).
- Une région en échec est redemandée 10 s plus tard si elle est toujours visible ;
  après une coupure du temps réel ou du réseau, les régions visibles sont redemandées
  ([coupure et reprise](../../docs/realtime.md#coupure-et-reprise-draw-03b)).
- Au-delà de 30 régions visibles (vue éloignée, WEB-03d), rien n'est chargé. Avec le
  zoom minimal actuel (×1), un écran 2560 × 1440 en montre au plus 12.
- `/admin clear` (nouvelle `canvas_version`) oublie toutes les régions et recharge
  celles qui sont visibles.

## Inspection et dessin d'un pixel (WEB-04)

- **Sélection** : un clic sans glisser (moins de 6 px de déplacement), ou `Entrée` pour
  le pixel au centre ; `Échap` désélectionne. Le pixel est entouré par un seul élément
  posé sur le canvas, déplacé avec la caméra.
- **Auteur et date** : `GET /api/tiles/{tx}/{ty}/meta` à la sélection, puis de nouveau
  quand un delta temps réel touche la tuile (une seule lecture par rafale, 300 ms après
  le dernier delta). Pas de lecture en boucle.
- **Dessin** : palette de 16 couleurs, « Poser le pixel » envoie `POST /api/pixels`. Le
  `202` veut dire « accepté », pas « dessiné » :
  - le pixel est « posé » quand son delta arrive avec la couleur envoyée ;
  - sinon, 3 s plus tard, une lecture de `/api/state` dit si le worker l'a refusé
    (`last_rejection` avec le même `event_id` : pause, quota, hors de la grille…) ;
  - un échec d'envoi n'est jamais renvoyé automatiquement : un `202` perdu ferait un
    second trait (voir [`web-proxy`](../../docs/web-proxy.md)).
- **Avant l'envoi**, le bouton est désactivé si la toile est en pause (listener de
  `config/global`), si le pixel est hors de la grille (`size`), ou si le quota est épuisé.
  Le quota vient de `/api/state`, lu au démarrage et après chaque dessin ; il redevient
  plein à `reset_at`. C'est toujours le serveur qui décide.

| Fichier | Rôle |
| --- | --- |
| `src/api/grid.ts` | Appels `meta`, `state` et `pixels`, réponses validées |
| `src/inspect/inspector.ts` | Sélection, auteur, quota, envoi et confirmation, sans React |
| `src/inspect/PixelPanel.tsx`, `Workspace.tsx` | Panneau du pixel et assemblage avec le canvas |

## Pinceau (WEB-05)

- Outil « Pinceau » du panneau : taille de **1 à 100** pixels de côté (slider), carré ou
  rond, couleur de la palette. Glisser sur la toile peint ; le clic droit, la molette
  enfoncée, deux doigts ou les flèches déplacent la vue.
- **Pixels d'un trait** (`src/brush/stroke.ts`) : le pinceau est appliqué en chaque point
  du chemin (Bresenham entre deux événements pointeur, plus les événements regroupés
  par le navigateur), donc un trait rapide n'a pas de trou. Entre deux points voisins,
  seul le bord avant du tampon est ajouté (≈ 100 pixels par pas à la taille 100, au lieu
  de 10 000). Chaque pixel n'apparaît qu'une fois par trait, donc jamais deux fois dans
  une requête (`400 duplicate_pixel`). Hors de la grille bornée (`size`) ou de ±10⁹, il
  est ignoré.
- **Envoi** (`src/brush/brush.ts`) : le **même pipeline qu'un pixel seul**, sans endpoint
  ni événement propre au pinceau (ADR-0014). Les pixels partent au fil du trait par
  requêtes `POST /api/pixels` de 500 au plus, quatre en parallèle au maximum, et le
  reste au relâchement. La toile n'affiche que ce que les deltas apportent.
- **Aperçu** (`src/brush/preview.ts`) : ce qui vient d'être envoyé (trait ou « Poser le
  pixel ») s'affiche tout de suite sur un **calque distinct et semi-transparent**, un
  second canvas posé sur la toile. Ce n'est pas l'état : la toile, elle, ne change
  qu'avec les deltas et montre toujours l'état réel (sujet §3.3), et l'aperçu ne fait
  que marquer ce qui est en cours d'envoi, sans jamais passer pour un pixel posé. Un
  pixel de l'aperçu disparaît quand la toile montre sa couleur (son delta est arrivé),
  dès que son refus est connu, sinon au bout de 5 s ; un `/admin clear` vide l'aperçu.
  La case « Aperçu de l'envoi » du panneau le désactive : seule la toile reste, mise à
  jour par les deltas. Le choix est gardé dans le `localStorage` du navigateur
  (`pixelwar.preview`).
- **Quota et refus** : chaque pixel couvert est **décompté tout de suite** du quota
  affiché (`PixelInspector.consume`), car `/api/state` ne le voit qu'une fois traité par
  le worker : deux traits rapides ne croient donc pas avoir tout le quota. Le trait
  s'arrête au quota restant, et rien n'est dessiné ni envoyé au-delà. Chaque lecture de
  `/api/state` recale sur le chiffre du serveur (dessins faits depuis Discord compris),
  et c'est lui qui décide.
- Un seul message par trait : 3 s après la fin, `/api/state` dit si le dernier refus
  appartient à l'un de ses événements ; l'aperçu du trait est alors retiré tout de
  suite. Après un échec d'envoi, le reste du trait est abandonné, jamais renvoyé
  automatiquement. En pause, le pinceau ne démarre pas.
- **Démo de charge** : un admin relève la limite d'un compte avec `/admin ratelimit`
  (par exemple 1 000 000 pixels par minute), puis un trait à la taille 100 envoie
  plusieurs milliers de pixels par seconde. Le débit par instance du `draw-worker` se lit
  sur le dashboard (DRAW-05).

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
