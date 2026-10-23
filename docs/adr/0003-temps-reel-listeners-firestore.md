# ADR-0003 · Temps réel : listeners Firestore sur des deltas par région

- **Statut** : Accepté
- **Date** : 2026-10-23
- **Tickets** : ARCH-01 (#26). Utilisé par DATA-01, DRAW-02, DRAW-03a, DRAW-03b, DRAW-04, WEB-03c, WEB-03d.
- **Références** : Sujet §3.4 · C06 §4.4, §7 · C07 §3.3

## Contexte

- Le canvas doit se mettre à jour en temps réel, par événements ou par streaming. Le polling et les boutons de rafraîchissement sont interdits (§3.4, C07 §3.3).
- Un pixel posé depuis Discord doit apparaître sur le web sans rafraîchir, et inversement.
- On ne transmet que les pixels modifiés (C06 §7, « Change feed »).
- Toutes les entrées publiques passent par API Gateway (§3.1). API Gateway sait maintenant relayer des WebSockets et du SSE, mais seulement en mode *streaming*, qui est en **Preview** et **ne peut pas être activé par Terraform** (documentation API Gateway, « Configure streaming »).
- Un viewport à fort zoom arrière couvre des centaines de tuiles, et une requête Firestore `in` accepte au plus 30 valeurs.

## Décision

Le navigateur s'abonne avec des **listeners Firestore** (`onSnapshot`) à une collection **`deltas`**, en lecture seule grâce aux règles de sécurité.

### Côté écriture : le `draw-worker`

- Pour chaque lot traité, il écrit **un document de delta par région touchée**, une région faisant 1024×1024 pixels (ADR-0007).
- Contenu d'un delta : région, `canvas_version`, `created_at` (horodatage serveur), `expire_at` (TTL court, par exemple 1 h) et la liste compacte des pixels modifiés.
- Il écrit le delta **dans la même transaction que les tuiles** qu'il modifie, avec le même horodatage serveur. Un client ne peut donc pas recevoir un delta sans que la tuile correspondante soit à jour, ni l'inverse.

### Côté lecture : le navigateur

1. Il ouvre le listener `deltas where region in [régions visibles] and created_at > T0`, au plus 30 régions. Au-delà, en vue éloignée, il écoute le flux global `deltas where created_at > T0`. `T0` est pris un peu dans le passé (par exemple une minute), pour absorber le décalage d'horloge du navigateur : la règle 3 élimine les doublons.
2. Il charge ensuite les tuiles du viewport. Chaque tuile porte son `updated_at`. Les deltas qui arrivent avant leur tuile sont gardés en mémoire.
3. Il n'applique sur une tuile que les deltas dont `created_at` est postérieur à son `updated_at`. Comme une tuile et son delta partagent le même horodatage, aucun pixel ne peut revenir à un état plus ancien.
4. Quand le viewport change, il recrée le listener avec les nouvelles régions et un nouveau `T0`. Le résultat local de la requête ne grossit donc pas indéfiniment.

Deux autres listeners donnent l'état de l'utilisateur (DRAW-04) :

- `config/global` : pause et `canvas_version`. Un changement de version, après un `/admin clear`, vide le cache de tuiles ;
- `users/{uid}` : quota restant et dernier rejet.

Les listeners se reconnectent et se resynchronisent seuls. Si la coupure a duré plus longtemps que le TTL des deltas, le client recharge les tuiles visibles (DRAW-03b).

## Options écartées

| Option | Pourquoi elle est écartée |
|---|---|
| WebSocket ou SSE via API Gateway (mode streaming) | En Preview, et impossible à activer par Terraform : la gateway ne serait plus déployée en IaC (§3). Le mode ne se change pas sur une gateway existante, et les domaines personnalisés ne sont pas pris en charge. Il faudrait aussi un service Cloud Run qui garde les connexions ouvertes : une instance facturée tant qu'un client est connecté, des connexions coupées au bout d'une heure au plus, et un relais (*backplane*) pour diffuser chaque pixel à toutes les instances. |
| WebSocket directement sur Cloud Run | Le service serait public (`allUsers`) et contournerait la gateway : interdit par §3.1 et par SEC-01. |
| Firebase Realtime Database comme canal de diffusion | Une deuxième base de données à déployer, sécuriser et surveiller, pour le même résultat que Firestore, qu'on utilise déjà. La question des lectures directes depuis le navigateur (ADR-0004) se poserait de la même façon. |
| Service tiers (Pusher, Ably…) | Hors du fournisseur cloud, avec un secret de plus, et absent de notre monitoring et de notre diagramme. |
| Un document par région, réécrit à chaque lot | Un listener peut fusionner des mises à jour rapides d'un même document, et donc rater des pixels. Un document très souvent réécrit devient aussi un point chaud en écriture. Une collection où l'on ne fait qu'ajouter des documents n'a aucun de ces deux problèmes. |
| Polling ou bouton de rafraîchissement | Interdit (§3.4). |

## Conséquences

**Ce qu'on y gagne**

- Aucun serveur à maintenir pour le temps réel : Firestore diffuse les changements, gère la reconnexion et la reprise.
- Seuls les pixels modifiés transitent, regroupés par lot et par région.
- Discord et le web arrivent au même endroit (le `draw-worker` écrit les deltas), donc ils sont synchronisés par construction.

**Ce que ça coûte, et ce qu'il faut surveiller**

- Chaque delta reçu par un client compte comme une lecture Firestore : le coût croît avec « nombre de deltas × nombre de clients abonnés à la région ». Regrouper par lot et par région limite ce nombre. À suivre dans le dashboard (OBS-02).
- `created_at` augmente sans cesse et il est indexé : la documentation Firestore indique alors un maximum d'environ 500 écritures par seconde sur la collection. Un delta regroupant un lot entier, c'est largement suffisant pour la démo, mais il faut le vérifier pendant le test de charge (OBS-05a).
- Le TTL de Firestore supprime les documents expirés en général dans les 24 h, et ils restent visibles dans les requêtes jusqu'à leur suppression. Les requêtes filtrent donc toujours sur `created_at` : le TTL ne sert qu'à nettoyer le stockage.
- Le navigateur lit Firestore directement, sans passer par la gateway : ce point est justifié à part, dans l'ADR-0004.

## En soutenance

- « API Gateway ne permet les WebSockets qu'en Preview, et pas en Terraform. On s'appuie donc sur les listeners Firestore, que le support C07 cite justement comme canal temps réel. »
- « Le worker écrit la tuile et le delta dans la même transaction. Le client n'applique un delta que s'il est plus récent que la tuile chargée : l'affichage ne régresse jamais. »
- « Il n'y a pas de polling : c'est Firestore qui pousse les changements. »
