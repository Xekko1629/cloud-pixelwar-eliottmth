# DATA-03 — Calcul des quotas utilisateur (première partie)

## Périmètre livré

`app/shared/src/grid/rate-limit.ts`, exporté par `@pixelwar/shared/grid`, calcule
une décision **pure**, sans réseau, SDK Firestore, écriture ni réservation de
quota. Le worker Discord/web utilisera la même règle et le même document
`users/{uid}` ; il n'existe pas encore d'intégration dans un worker.

Cette partie ne clôture pas DATA-03 : la transaction Firestore, la concurrence,
la déduplication persistante, les commandes admin et les réponses Discord sont
encore à intégrer/tester avec DATA-02 et les tickets de workers.

## Contrat validé

- Fenêtres fixes alignées sur chaque minute UTC, début inclus, fin exclue.
  Ex. `[12:34:00, 12:35:00[`. Pas de remise à zéro planifiée : une fenêtre passée
  vaut logiquement zéro lors du prochain traitement.
- `now_ms` vient de l'horloge **serveur du worker**, rafraîchie à chaque tentative
  de transaction, après ses lectures. Jamais de l'heure client ou `occurred_at`.
  Le module ne lit pas lui-même `Date.now()` et reste déterministe.
- Source obligatoire : `config/global.default_limit_per_minute`, initialisée
  explicitement à **20**. L'override `ratelimit_overrides/{uid}.limit_per_minute`
  prend priorité s'il existe. Les limites sont des entiers sûrs positifs ou nuls.
- Une modification s'applique au prochain calcul sans effacer les pixels déjà
  consommés dans cette minute. `users.limit_per_minute` est un snapshot
  informatif, pas la source de la limite courante.
- Quota zéro = aucun dessin pour cet utilisateur tant que sa limite effective
  reste zéro. Un défaut global à zéro peut être relevé par un override ; ce
  n'est pas le drapeau de pause globale, que le worker doit vérifier séparément.
- Chaque pixel du lot compte ; un dépassement refuse **tout le lot**, sans
  consommation partielle. La taille maximale de lot/budgets de DATA-01 reste
  un contrôle distinct : dériver `pixel_count` du tableau de pixels validé,
  jamais d'un compteur déclaré par le client.
- La rafale de fin/début de minute est assumée : jusqu'à 20 pixels juste avant
  la frontière puis 20 juste après avec une limite de 20.

Une configuration absente ou invalide provoque `RateLimitDataError`, même si un
override est valide. Pas de repli silencieux sur 20. Le worker devra laisser
réessayer avec backoff/DLQ et alerter ; ce n'est pas un rejet métier définitif.

## API et résultat

```ts
import { evaluateRateLimit } from '@pixelwar/shared/grid';

const decision = evaluateRateLimit({
  config: { default_limit_per_minute: 20 },
  override: null,
  usage: null, // sinon window_start, used_pixels et updated_at lus en transaction
  now_ms: Date.now(), // dans le worker, à chaque tentative de transaction
  pixel_count: 5, // longueur du lot validé
});
```

`resolveRateLimit(config, override)` résout et valide uniquement la limite.
`INITIAL_DEFAULT_LIMIT_PER_MINUTE = 20` sert à l'initialisation explicite,
**pas à masquer une configuration manquante**.

Le résultat expose la limite, la taille demandée, `used_before`, le restant
après décision, `window_start_ms` et `reset_at_ms` :

- `allowed: true` : `next_usage` contient les valeurs numériques proposées
  (`window_start_ms`, `used_pixels`, `limit_per_minute`, `updated_at_ms`).
  Elles ne deviennent effectives qu'après le commit atomique du dessin.
- `allowed: false` : aucun `next_usage`, aucune consommation du lot.

| Refus métier | `retry_after_seconds` | Indication pour le futur notifier |
| --- | --- | --- |
| `insufficient_quota` | Secondes jusqu'à la prochaine minute, arrondies au supérieur | Lot de 5, restant 3/20 : quota insuffisant, réinitialisation dans 18 s |
| `batch_exceeds_limit` | `null` | Lot de 25 pour limite de 20 : réduire le lot ou modifier la limite, attendre seul ne suffit pas |
| `drawing_disabled` | `null` | Quota effectif nul : pas de promesse de déblocage à la minute suivante |

Le délai est une information calculée au traitement, pas une garantie que le
quota sera disponible à réception du message Discord ou après une modification
admin. Le rendu du message n'est pas implémenté ici. Ces sous-raisons relèvent
du motif métier/observabilité `rate_limit` lors du futur mapping d'événements.

`RateLimitDataError.code` distingue `invalid_configuration`, `invalid_usage`,
`invalid_clock` et `invalid_pixel_count`. Ne pas convertir automatiquement ces
exceptions en refus métier. Compteur négatif/non entier, fenêtre mal alignée ou
usage daté dans le futur : échec prudent, pas de reset qui recréerait du quota.
`updated_at` accepte la précision nanoseconde Firestore. Le début de fenêtre
exige une minute exacte, sans nanoseconde. L'heure worker est un entier en ms
depuis 1970 et la fenêtre, y compris sa fin, doit tenir dans la plage Firestore.

## Intégration DATA-02 — obligatoire avant mise en service

Dans **la même transaction serveur** :

1. Lire le document de déduplication par `event_id`. S'il existe, reprendre son
   résultat original, succès ou refus, sans réévaluer le quota ni la config.
2. Sinon, lire config, override et compteur, ainsi que les documents nécessaires
   au dessin. Toutes les lectures précèdent les écritures.
3. Reprendre l'heure worker pour cette tentative et appeler le calcul pur.
   Un changement concurrent de config/override/compteur doit provoquer la
   relecture et le recalcul via la transaction, pas l'emploi d'un cache local.
4. Acceptation : écrire tuiles, métadonnées, deltas, compteur et résultat de
   déduplication ensemble. Convertir les temps numériques avec le vrai
   `Timestamp.fromMillis` du SDK ; ne pas écrire de faux objets Timestamp.
5. Refus métier : mémoriser le refus et les détails nécessaires pour restituer
   le résultat original, sans dessin ni consommation du lot. Pas de `next_usage`
   à appliquer. Une nouvelle action utilisateur reçoit un nouvel `event_id`.
6. Erreur technique : pas de résultat définitif ni de commit partiel. Laisser
   les mécanismes de reprise agir ; ne pas lancer une boucle immédiate infinie.

Ne pas consommer le quota dans une transaction séparée, ni faire confiance au
frontend pour l'autorisation. Sérialiser les modifications concurrentes via
`users/{uid}`, commun à Discord/web (identité ADR-0005). Ne pas supprimer ce
compteur ou changer son `window_start` lors d'un override admin.

La conservation des résultats de déduplication doit couvrir l'horizon autorisé
de rejeu Pub/Sub/DLQ (7 jours prévus), avec une marge à fixer dans DATA-02.
Ne pas réutiliser le TTL court des deltas pour ces documents. La publication
fiable du résultat après commit reste un point d'architecture ouvert : aucun
appel Discord/Pub/Sub dans une callback susceptible d'être réexécutée.

## Initialisation et migration

Avant de brancher le worker, initialiser le champ `default_limit_per_minute`
à 20 dans `config/global`, via une opération admin autorisée qui **préserve**
les champs pause/version/taille existants. Une simple mise à jour ciblée ou un
merge convient ; ne pas remplacer le document complet par ce seul champ.
Aucune écriture GCP n'est effectuée par ce changement de code.

## Vérification

Depuis `app/`, Node 24 : `npm run typecheck`, `npm run test:coverage` et
`npm run test:integration`. Tests unitaires DATA-03 : frontières UTC, compteurs,
brush, override/défaut modifiés, quota zéro, lot trop grand, données invalides,
arithmétique sûre, propositions immuables. Pas encore de test de concurrence
Firestore ou de rejeu métier persistant DATA-03 ; les tests d'intégration du
socle ne prouvent pas ces propriétés.

Sources officielles consultées le 6 novembre 2026, après le premier calcul pur
pour préciser son contrat d'intégration :
- [Transactions Firestore : atomicité, lectures et retries](https://firebase.google.com/docs/firestore/manage-data/transactions)
- [Contention et isolation des transactions serveur](https://firebase.google.com/docs/firestore/transaction-data-contention)
