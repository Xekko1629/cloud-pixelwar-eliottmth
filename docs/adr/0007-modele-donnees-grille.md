# ADR-0007 · Données : grille infinie ou bornée par un admin, tuiles 64×64, régions 1024×1024, palette de 16 couleurs

- **Statut** : Accepté
- **Date** : 2026-10-23
- **Tickets** : ARCH-01 (#26). Cadre de DATA-01, qui détaille le schéma, les encodages et le calcul des coûts. Utilisé aussi par DATA-02 à DATA-05c, BOT-02, BOT-06, BOT-07a, DRAW-01 à DRAW-03a, WEB-03a à WEB-05.
- **Références** : Sujet §3.3, §3.4 · C06 §4 · C07 §3.4

## Contexte

- La grille fait « at least 10000×10000 pixels, or effectively infinite », et doit rester performante en lecture, en écriture et au rendu. Stocker toute la grille dans un seul document est exclu (§3.3).
- Pour chaque pixel, on garde au moins sa couleur, son auteur et la date de sa dernière modification, consultables depuis le frontend.
- Limites de Firestore qui dimensionnent le modèle (documentation Firestore) :
  - **1 Mio par document** ;
  - **40 000 entrées d'index par document** ;
  - une requête `in` accepte **au plus 30 valeurs** ;
  - un même document ne supporte qu'un débit d'écriture soutenu limité. L'ordre de grandeur couramment cité est d'une écriture par seconde ; la documentation actuelle dit que cela dépend de la charge, et qu'il faut le mesurer.
- `/draw` accepte une couleur « hex or palette value » (§3.2).

## Décision

### Une grille infinie

- La grille est **infinie** : on peut dessiner et se déplacer dans toutes les directions, sans bord.
- `x` et `y` sont des **entiers signés**, de -1 000 000 000 à 1 000 000 000. `x` croît vers la droite, `y` vers le bas, et `(0, 0)` est l'origine où le frontend s'ouvre. Cette borne n'existe que pour valider les entrées : elle donne 2 milliards de pixels par côté, elle tient dans un entier 32 bits et dans les options entières de Discord, et garde des identifiants de documents courts.
- Rien n'est préalloué : **seules les tuiles où au moins un pixel a été peint existent**. Le coût de stockage dépend de ce qui est dessiné, pas de la taille de la grille.
- `config/global.bounds` garde le rectangle qui englobe tous les pixels peints. Le `draw-worker` l'agrandit quand un pixel tombe en dehors. Il sert au bouton « voir tout le dessin » du frontend, et au rendu de `/get` et `/snapshot`.

### Taille réglable par un admin : `/admin size`

La grille est infinie par défaut, mais un admin peut la borner, puis la rendre de nouveau infinie, sans redéployer.

- **Commande** : `/admin size [width] [height]`, avec les mêmes contrôles d'autorisation que les autres commandes `/admin` (BOT-08).
  - Sans option : la grille redevient infinie.
  - Avec `width` et `height` : la grille devient le rectangle allant de `(0, 0)` à `(width - 1, height - 1)`.
  - Chaque côté va de 10 000 (le minimum du sujet, §3.3) à 10⁹ (la borne de validation ci-dessus).
- **Stockage** : `config/global.size`, qui vaut `null` (infinie) ou `{ width, height }`. Le `command-worker` l'écrit, comme il écrit l'état de pause.
- **Qui vérifie quoi** :
  - les proxies valident seulement les bornes fixes (±10⁹ et la palette). Ils ne lisent pas Firestore, et restent donc légers ;
  - le `draw-worker` lit `config/global.size`, comme la pause, et rejette les pixels hors de la grille avec le motif `out_of_bounds` (`pixel-rejected`) ;
  - le frontend écoute `config/global` (DRAW-04) : il affiche le bord de la grille, limite le déplacement et refuse de dessiner en dehors.
- **Réduire la grille ne supprime rien.** Les pixels qui sortent du rectangle restent stockés, mais ne sont plus affichés, ni dessinables, ni rendus par `/get` et `/snapshot`. Si on agrandit de nouveau la grille, ils réapparaissent. Pour repartir de zéro, il y a `/admin clear`.
- `/get` et `/snapshot` rendent l'intersection de `bounds` (la zone peinte) et de `size` (la grille).

### Palette de 16 couleurs

- Les 16 couleurs de r/place 2017, stockées sur **1 octet par pixel** : `0` = jamais peint (affiché en blanc), `1` à `16` = index dans la palette.

  | # | Couleur | # | Couleur | # | Couleur | # | Couleur |
  |---|---|---|---|---|---|---|---|
  | 1 | `#FFFFFF` | 5 | `#FFA7D1` | 9 | `#E5D900` | 13 | `#0083C7` |
  | 2 | `#E4E4E4` | 6 | `#E50000` | 10 | `#94E044` | 14 | `#0000EA` |
  | 3 | `#888888` | 7 | `#E59500` | 11 | `#02BE01` | 15 | `#CF6EE4` |
  | 4 | `#222222` | 8 | `#A06A42` | 12 | `#00D3DD` | 16 | `#820080` |

- Dans Discord, l'option `color` de `/draw` propose ces 16 choix : Discord en autorise 25 au maximum par option (BOT-02). Le frontend affiche la même palette.
- Pourquoi une palette plutôt que la couleur libre : on stocke 1 octet au lieu de 3, la validation se réduit à vérifier un index, et le rendu PNG peut être indexé (DATA-05). Le sujet accepte les deux.

### Tuiles de 64×64

- La grille est découpée en tuiles de 64×64 pixels, indexées par `(tx, ty) = (⌊x/64⌋, ⌊y/64⌋)`. La division arrondit **vers le bas**, y compris pour les coordonnées négatives : le pixel `x = -1` est dans la tuile `tx = -1`, au rang local 63. Cette fonction est écrite une seule fois dans le paquet partagé (ADR-0008), et testée sur les valeurs négatives.
- Chaque tuile a **deux documents**, pour que le canvas ne charge que ce dont il a besoin :
  - **couleurs** : un champ `Bytes` de 4 096 octets (un par pixel) et `updated_at`. C'est ce que charge le canvas. Une tuile absente est une tuile vide : le frontend n'a rien à télécharger ;
  - **métadonnées** : une map `pixels` indexée par la position locale `0..4095`, chaque entrée contenant `uid` (id Discord sous forme de chaîne), `name` (pseudo au moment de la modification), `at` (`occurred_at` en Timestamp Firestore) et `eid` (UUID d'événement sur 16 octets, pour départager deux événements de même horodatage). Elles ne sont chargées que lorsqu'on inspecte un pixel (WEB-04). Le champ `pixels` est exclu de l'indexation (exemption d'index), sinon chaque pixel compterait dans la limite de 40 000 entrées d'index et alourdirait chaque écriture.
- Les deux documents portent le même identifiant `v{canvas_version}_{tx}_{ty}`, ainsi que `canvas_version`, `tx`, `ty`, `region` et `updated_at`. Le préfixe de version permet d'effacer toute la grille en temps constant, sans tout supprimer d'un coup (DATA-04). Sur une grille infinie, c'est la seule façon raisonnable d'effacer.
- Le format binaire des deltas est décrit dans ADR-0003 ; les index composites et les exemptions de champs sont déclarés dans `app/firestore.indexes.json`.

Pourquoi 64 :

| Taille | Couleurs par tuile | Métadonnées au pire (ID 20 chiffres, pseudo 128 octets UTF-8) | Verdict |
|---|---|---|---|
| 32×32 | 1 Kio | environ 232 Ko | Quatre fois plus de documents à lire pour le même viewport. |
| **64×64** | **4 Kio** | **928 865 octets** | Tient sous 1 Mio, avec environ 120 Kio de marge. Un viewport 1920×1080 à 1 pixel d'écran par pixel de grille charge au plus environ 550 tuiles, soit 2,2 Mo, et beaucoup moins là où rien n'est peint. |
| 128×128 | 16 Kio | environ 3,7 Mo | Impossible : dépasse 1 Mio. |
| 256×256 | 64 Kio | environ 14,9 Mo | Impossible : dépasse 1 Mio. |

Le calcul réel compte les noms de champs, les valeurs et le surcoût de 32 octets par map Firestore. Une tuile pleine avec un pseudo réaliste de 32 octets reste autour de 543 Ko, et environ 445 Ko avec un pseudo de 8 octets : l'ancienne estimation de 200 Ko était trop optimiste. Le code partagé `app/shared/src/grid/metadata.ts` implémente ce calcul et le test le vérifie. La marge n'autorise pas l'ajout d'un nouveau champ par pixel sans re-mesure.

### Régions de 1024×1024

- Une région regroupe 16×16 tuiles, et s'indexe par `(rx, ry) = (⌊x/1024⌋, ⌊y/1024⌋)`.
- C'est l'unité du **temps réel** : un delta par lot et par région (ADR-0003).
- Un viewport 1920×1080 au zoom 1 touche au plus 6 régions, loin de la limite de 30 de la requête `in`. Quand le viewport en couvre plus de 30, le frontend est en vue éloignée et écoute le flux global. Le volume de ce flux dépend du rythme de dessin de tous les utilisateurs, pas de la taille de la grille.

### Vue éloignée : une pyramide d'images

On ne peut pas afficher une grille infinie d'un coup. Comme une carte en ligne, la vue éloignée utilise des images basse résolution à plusieurs niveaux de zoom (DATA-05c, WEB-03d) :

| Niveau | Une image de 256×256 couvre | Échelle |
|---|---|---|
| 1 | 1 région (1024×1024 pixels) | 1 pixel d'image pour 4×4 pixels de grille |
| 2 | 4×4 régions (4096×4096) | 1 pour 16×16 |
| 3 | 16×16 régions (16384×16384) | 1 pour 64×64 |

- Les images ne sont générées que là où quelque chose est peint. Une image absente est une zone vide.
- Quand une région change, l'`overview-worker` régénère son image de niveau 1, puis celles des niveaux 2 et 3 qui la contiennent.
- Le dézoom s'arrête au niveau 3. Un écran 1920×1080 couvre alors environ 120 000×70 000 pixels de grille, soit une quarantaine d'images. On peut se déplacer à l'infini, mais pas tout voir d'un coup : le bouton « voir tout le dessin » cadre sur `bounds`, dans la limite de ce zoom.

### `/get` et `/snapshot`

Ils rendent le rectangle `bounds`, c'est-à-dire tout ce qui a été peint (limité à `size` si la grille est bornée), et pas la grille entière. Si ce rectangle dépasse une taille maximale (par exemple 4096 pixels de côté), l'image est réduite, à partir des images de la pyramide quand c'est possible. Cela borne la mémoire du `render-worker` et du `snapshot-worker` (DATA-05b), quelle que soit l'étendue du dessin.

### Autres documents

- `deltas/{id auto}` : temps réel, avec un TTL court (ADR-0003).
- `config/global` : pause, `canvas_version`, `bounds`, `size` et
  `default_limit_per_minute` (DATA-03, initialisé explicitement à 20).
- `users/{uid}` : quota de la fenêtre en cours, dernier rejet. `uid` = id Discord (ADR-0005).
- `ratelimit_overrides/{uid}` : limites fixées par `/admin ratelimit`, illisibles depuis le navigateur.
- Documents de déduplication par `event_id`, avec TTL (DATA-02).

### Quotas utilisateur — décisions DATA-03 du 6 novembre 2026

- Fenêtre fixe par minute UTC, selon l'heure serveur du worker, pas `occurred_at`.
  Une rafale à cheval sur deux minutes est acceptée comme limite de ce modèle.
- Override utilisateur prioritaire sur le défaut Firestore ; changement immédiat
  sans remise à zéro du compteur. Zéro interdit de dessiner pour la limite
  effective concernée, indépendamment du contrôle séparé de pause globale.
- Un lot dépassant le quota est refusé en entier sans consommation. Les refus
  métier doivent être dédupliqués comme les succès ; une erreur de configuration
  reste technique et réessayable, sans repli silencieux sur 20.
- Le calcul partagé est pur ; compteur, dessin et déduplication devront être
  atomiques dans DATA-02. Aucun mécanisme de réservation séparée.

Voir [le contrat et les limites d'intégration DATA-03](../rate-limits.md).

### Écriture

- Un lot accepté est plafonné à **500 pixels** par défaut, valeur configurable. Un trait plus long est redécoupé côté client ; un lot qui dépasse les budgets de tuiles, de documents ou d'octets est refusé explicitement, pas appliqué partiellement. Le budget transactionnel exact reste à mesurer avec DATA-02.
- Le `draw-worker` groupe les pixels d'un lot **par tuile** : une écriture pour le document de couleurs et une pour celui des métadonnées de chaque tuile touchée, dans une transaction qui écrit aussi **un delta par région** (ADR-0003). Un lot touchant `T` tuiles et `R` régions écrit donc `2T + R` documents, avant les documents annexes (déduplication, quota, `bounds`) ; le code partagé expose ce calcul et un budget configurable.
- La concurrence maximale du worker est plafonnée (DRAW-02), pour rester sous le débit qu'un document de tuile supporte.
- `bounds` n'est réécrit que si le lot sort du rectangle actuel, ce qui devient vite rare. Ce document ne devient donc pas un point chaud en écriture.

## Options écartées

| Option | Pourquoi elle est écartée |
|---|---|
| Grille fixe de 10000×10000, inscrite dans le code | Suffit pour le sujet, mais une grille infinie est plus intéressante et ne coûte presque rien de plus avec un stockage creux. Avec `/admin size`, on garde de toute façon la possibilité de borner la grille, sans redéployer. |
| Taille fixée par une variable Terraform | Changer la taille demanderait une release. Une commande admin agit tout de suite et se montre en démo. |
| Supprimer les pixels qui sortent de la grille quand on la réduit | Opération coûteuse et irréversible, pour un simple réglage. `/admin clear` existe déjà pour repartir de zéro. |
| Coordonnées sans aucune borne | Les entiers JavaScript perdent en précision au-delà de 2⁵³, et Discord borne lui aussi ses options entières. Une borne à un milliard reste infinie en pratique. |
| Un document par pixel | Charger un viewport demanderait des centaines de milliers de lectures, donc un coût et une latence inacceptables. |
| Toute la grille dans un document | Interdit par le sujet (§3.3), et impossible avec la limite de 1 Mio. |
| Couleurs et métadonnées dans le même document | Le canvas téléchargerait l'auteur et la date de chaque pixel alors qu'il n'en affiche jamais qu'un seul à la fois, à la demande. |
| Couleur libre en RGB | 3 octets par pixel au lieu de 1, et pas de liste de choix dans Discord. Le sujet ne l'impose pas. |

## Conséquences

**Ce qu'on y gagne**

- Le stockage, les lectures et le coût suivent ce qui est dessiné, pas la taille de la grille.
- Le canvas ne télécharge que des tableaux d'octets compacts, et seulement pour ce qui est visible et peint.
- L'inspection d'un pixel coûte une seule lecture supplémentaire.
- La même découpe (tuiles, régions, pyramide) sert au stockage, au temps réel, au rendu et à la vue éloignée.

**Ce que ça coûte, et ce qu'il faut surveiller**

- **Coordonnées négatives** : l'arrondi vers le bas des divisions est le piège classique. Les tests du paquet partagé couvrent `-1`, `-64`, `-65` et les bornes.
- **Rendu du frontend** : à des coordonnées comme 10⁹, les nombres flottants 32 bits de WebGL perdent leur précision. Le canvas calcule ses positions par rapport à la caméra, jamais en coordonnées absolues (WEB-03a).
- **Dispersion volontaire** : un utilisateur qui peint des pixels très éloignés crée une tuile et une région par pixel. Le rate limit (DATA-03) borne ce coût, et le test de charge doit aussi essayer ce cas.
- **Pyramide** : un pixel modifié entraîne jusqu'à trois images à régénérer. L'`overview-worker` les regroupe par cycle (DATA-05c) ; la fraîcheur compte peu, puisque les deltas s'appliquent en direct par-dessus.
- Une tuile très sollicitée (beaucoup de pixels au même endroit pendant le test de charge) peut provoquer des conflits de transaction. À mesurer pendant OBS-05a, et à atténuer en plafonnant la concurrence du worker.
- `/admin size` ne fait pas partie des commandes imposées par le sujet (§3.2), qui demande d'implémenter « exactly these ». On la présente comme une commande en plus, qui ne modifie aucune des commandes obligatoires. À signaler à l'encadrant, en même temps que la question de l'ADR-0004.
- Changer la taille des tuiles ou des régions après coup impose de migrer toutes les données. Ces valeurs sont donc fixées ici, et ne changeront que par un nouvel ADR.

## En soutenance

- « La grille est infinie : on ne stocke que les tuiles de 64×64 où quelque chose a été peint, donc le coût suit le dessin, pas la taille. »
- « Un admin peut la borner avec `/admin size`, sans redéployer. Le `draw-worker` applique la taille, comme la pause, et le frontend affiche le bord en temps réel. »
- « On sépare les couleurs, 4 Kio par tuile et chargées par le canvas, des métadonnées, chargées seulement à l'inspection. 64, parce que les métadonnées doivent tenir sous la limite de 1 Mio d'un document Firestore. »
- « Pour dézoomer, on affiche une pyramide d'images basse résolution, comme une carte. `/get` et `/snapshot` rendent la zone peinte, pas l'infini. »
