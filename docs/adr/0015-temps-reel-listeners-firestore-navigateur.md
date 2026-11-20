# ADR-0015 · Temps réel : listeners Firestore dans le navigateur, en lecture seule

- **Statut** : Proposé
- **Date** : 2026-11-20
- **Tickets** : DRAW-03a (#61), DRAW-03b (#62), DRAW-04 (#63), DRAW-06 (#133, abandonné), WEB-03c (#68), WEB-03d (#69), SRV-11 (#132), SEC-01 (#83), WEB-01 (#65). Remplace la partie « Temps réel » d'[ADR-0013](0013-lectures-temps-reel-sans-firebase.md) ; reprend le côté lecture d'[ADR-0003](0003-temps-reel-listeners-firestore.md), sans Firebase Auth.
- **Références** : Sujet §3.1, §3.4 · C06 §7 (« Real-time updates », « Entry point ») · C07 §3.3 · séance du 20/11/2026 (frontend) · [Listeners temps réel Firestore](https://firebase.google.com/docs/firestore/query-data/listen) · [Security Rules Firestore](https://firebase.google.com/docs/firestore/security/get-started)

## Contexte

- ADR-0013 diffusait les deltas par un service Cloud Run `realtime`, en SSE,
  appelé directement par le navigateur. C'était un point d'entrée public hors
  API Gateway, contraire à deux règles écrites :
  - sujet §3.1 (contraintes obligatoires) : « All public entry points go through
    an API Gateway » ;
  - C06 §7 : « nothing else is publicly reachable ».
- Le sujet et le cours désignent les listeners Firestore comme solution GCP :
  - C07 §3.3 cite en premier « Firestore real-time listeners (GCP) » ;
  - C06 §7 accepte un temps réel produit « automatically by your storage » ;
  - les références du sujet listent « GCP Firestore, real-time listeners (streaming) ».
- Séance du 20/11 : l'encadrant présente le listener temps réel Firestore comme la
  solution GCP, simple à mettre en place. Il précise aussi :
  - le navigateur n'écrit jamais directement dans le stockage ;
  - voir la toile sans être connecté est « libre à vous » ;
  - seule l'information « qui a écrit quoi » doit être réservée aux utilisateurs connectés.
- La revue intermédiaire a écarté Firebase pour l'hébergement (ADR-0011) et pour
  l'identité (ADR-0012). Ces deux choix ne changent pas.
- Dans un navigateur, la seule librairie qui ouvre un listener Firestore est la
  librairie cliente `firebase/firestore`. Un navigateur n'a pas d'identité IAM :
  ses accès sont contrôlés par les **Security Rules** de Firestore, qui ne
  reconnaissent que les identités Firebase Auth.

## Décision

### Lecture temps réel dans le navigateur

- Le frontend embarque **uniquement** `firebase/firestore` (et `firebase/app`, qui
  l'initialise). Il n'utilise ni Firebase Auth, ni Hosting, ni Functions, ni Analytics.
- Il ouvre deux listeners `onSnapshot` :
  - les deltas des régions visibles, avec la requête d'ADR-0003 : `canvas_version`,
    `region in [...]` (30 au plus), `created_at > T0`. Au-delà, en vue éloignée,
    il écoute le flux global de la version courante ;
  - le document `config/global` : pause, taille de la grille, `canvas_version`
    (un `/admin clear` vide le cache et recharge les tuiles), `bounds`.
- Les règles 2 à 4 d'ADR-0003 s'appliquent : on ignore un delta plus ancien que
  la tuile chargée, on recrée le listener quand le viewport change, et on
  recharge les tuiles après une coupure plus longue que le TTL des deltas. Le
  SDK gère seul la reconnexion.

### Security Rules : lecture seule, deux chemins

- Les règles sont déclarées en Terraform (`google_firebaserules_ruleset` et
  `google_firebaserules_release` pour `cloud.firestore`) dans `infra/serverless`,
  à côté de la base.
- Seules deux lectures sont autorisées, et **aucune écriture** :
  - `deltas/{id}` : contenu `x`, `y`, couleur, **sans auteur** ;
  - `config/global`.
- Tout le reste est refusé au navigateur : métadonnées des tuiles (auteurs),
  `users`, `ratelimit_overrides`, déduplication. Ces documents restent
  accessibles aux seules fonctions, par IAM.
- Les fonctions utilisent `@google-cloud/firestore` avec leur compte de service :
  les Security Rules ne s'appliquent pas à elles.

### Configuration du frontend

- La config web Firestore vient de `google_firebase_project` et
  `google_firebase_web_app` (provider `google-beta`), sur le même projet GCP.
  Il faut vérifier en dev si l'activation de Firebase est strictement nécessaire.
  La clé d'API est restreinte à l'API Firestore.
- `/config.js` expose `firestoreProjectId` et `firestoreApiKey`, deux valeurs
  publiques, à la place de `realtimeUrl` (ADR-0011). La CSP autorise
  `https://firestore.googleapis.com` dans `connect-src`.

### Ce qui reste derrière la gateway

- Toutes les écritures (ADR-0014), l'inspection d'un pixel, le chargement initial
  des tuiles et `GET /api/state` (`config/global` et `users/{uid}`) passent par
  `tile-reader` et le JWT de session (ADR-0013, partie « Lectures ponctuelles »).
- Le quota restant et le dernier rejet ne sont pas en temps réel : le frontend
  appelle `GET /api/state` au chargement et après chaque trait.

## Options écartées

| Option | Pourquoi elle est écartée |
|---|---|
| Service SSE `realtime` (ADR-0013) | Point d'entrée public hors API Gateway, contraire au sujet §3.1 et à C06 §7. Un service de plus à coder, déployer et surveiller. |
| Firebase Auth avec custom token, et règles par utilisateur | Réintroduit Firebase Auth, écarté en revue (ADR-0012). Le sujet n'exige le temps réel que pour la toile. |
| SSE ou WebSocket derrière API Gateway | Le mode streaming d'API Gateway est en Preview et ne se configure pas en Terraform (ADR-0003). |
| Polling de `tile-reader` | Interdit (sujet §3.4). |

## Conséquences

- Il ne reste qu'un service public hors gateway : le `frontend` (ADR-0011).
  SEC-01 vérifie en plus que les règles Firestore n'ouvrent que les deux chemins
  en lecture.
- Quiconque possède la config publique peut lire les deltas et la config : c'est
  l'information de la toile visible, sans les auteurs.
- Chaque delta reçu compte comme une lecture Firestore, par client abonné
  (ADR-0003). Le regroupement des écritures (ADR-0014) limite le nombre de deltas.
- La variable `REALTIME_URL` du frontend est remplacée par `FIRESTORE_PROJECT_ID`
  et `FIRESTORE_API_KEY`.
