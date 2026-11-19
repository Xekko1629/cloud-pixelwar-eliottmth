# Écriture transactionnelle des dessins

## Responsabilité

`@pixelwar/shared/drawing` expose un moteur Node.js appelé par le futur
`draw-worker`. Il ne reçoit pas directement d'enveloppe Pub/Sub et ne fait
aucun appel Discord. Web et Discord utilisent les mêmes règles de dessin.

```ts
import { Firestore } from '@google-cloud/firestore';
import { createDrawProcessor } from '@pixelwar/shared/drawing';

const processDraw = createDrawProcessor(new Firestore());
const result = await processDraw({
  event_id: '00000000-0000-4000-8000-000000000001',
  occurred_at: '2026-11-19T10:00:00.000Z',
  source: 'discord',
  author: { uid: '123456789012345678', name: 'Exemple' },
  pixels: [{ x: 0, y: 0, color: 2 }],
});
```

L'identifiant utilisateur est un ID Discord, y compris pour les commandes web
authentifiées. Les couleurs utilisent les indices de palette 1 à 16 ; 0 est
réservé aux pixels non peints. Le lot est limité à 500 pixels par défaut.

## Transaction et doublons

La transaction lit d'abord `processed_events/<event_id>` :

- résultat présent, même empreinte métier : retourner le résultat conservé ;
- même ID mais contenu différent : erreur technique `event_id_conflict` ;
- résultat absent : lire configuration, override, quota et tuiles, puis calculer
  toutes les écritures avant de les soumettre.

Une empreinte SHA-256 couvre ID, date, source, auteur et pixels triés. Elle ne
contient ni token Discord, ni trace, ni métadonnées de livraison.

Les couleurs, métadonnées des pixels, deltas, quota, limites de la zone peinte et
résultat sont écrits dans **une seule transaction**. Une relivraison retrouve
donc le même résultat sans nouvelle consommation. Les lectures précèdent les
écritures ; aucun effet réseau externe n'a lieu dans la callback rejouable.

Pour deux commandes distinctes sur le même pixel, la date `occurred_at` la plus
récente gagne. À dates égales, l'ordre déterministe des IDs départage les
commandes, conformément au modèle de grille. Un lot accepté consomme tous ses
pixels validés, même si certains sont ignorés car déjà dépassés.

## Refus et erreurs techniques

Les refus `paused`, `expired`, `out_of_bounds`, `batch_budget_exceeded` et
`rate_limit` produisent un résultat durable `pixel-rejected`, sans dessin ni
consommation supplémentaire. Le lot est refusé en entier. Un utilisateur déjà
présent reçoit aussi un `last_rejection` ; un document utilisateur absent n'est
pas créé pour un refus.

Une configuration invalide, une tuile corrompue, un ID réutilisé ou une panne
Firestore lèvent une erreur. L'adaptateur HTTP devra conserver ces traitements
réessayables, contrairement aux refus métier attendus.

## Publication après commit

`processAndPublishDraw(processDraw, publishResult, command)` attend le résultat
transactionnel, puis la confirmation de publication avant de retourner.
L'adaptateur push ne devra répondre 2xx qu'après cette confirmation.

Si la publication échoue après commit, la prochaine livraison relit et republie
le même résultat. Plusieurs publications restent possibles : les consommateurs
doivent dédupliquer le `result_id` stable `draw-result:<event_id>`.
Il ne s'agit pas d'une garantie de livraison « exactement une fois ».

## Rétention et budgets

- Âge maximal d'une nouvelle commande : 14 jours ; tolérance future : 5 secondes.
- Résultat conservé : `expire_at` fixé à 15 jours après traitement finalisé.
- Deltas : expiration à une heure par défaut, configurable.
- Un document expiré mais encore présent reste une preuve de déduplication.
- Budgets par défaut : 450 documents écrits et estimation de 8 Mio par transaction.
  L'estimation n'est pas une mesure exacte du protobuf envoyé à Firestore.

`app/firestore.indexes.json` déclare les politiques TTL sur `expire_at` pour
`processed_events` et `deltas`, ainsi que les exemptions d'index des données
binaires et du résultat. Écrire le champ ne suffit pas : la politique doit être
déployée séparément par une identité autorisée, avec la configuration Firestore
de SRV-06. Aucun déploiement de ces politiques n'est impliqué par les tests locaux.
Le nettoyage TTL est asynchrone et n'est pas validé par l'émulateur.

## Tests locaux

Depuis `app/` :

```bash
npm ci
npm run typecheck
npm run test:coverage
npm run test:integration
```

Les tests unitaires couvrent validation, budgets et planification des écritures.
Les tests sur émulateur vérifient les transactions réelles : doublons concurrents,
écritures concurrentes sur une tuile ou un pixel, quota concurrent et reprise
après échec de publication. Ils utilisent uniquement `demo-pixelwar-test` et
des racines de documents isolées, nettoyées après exécution.

Ces preuves ne valident ni IAM/OIDC, ni le nettoyage TTL cloud, ni les limites
et performances en charge de Firestore. L'agrandissement de la zone peinte
modifie un document global partagé : sa contention reste à mesurer en dev.
