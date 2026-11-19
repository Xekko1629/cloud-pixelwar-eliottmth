# Draw worker

Entrée HTTP Node.js 24 : `handleDrawWorker`. Consomme `pixel-draw`, appelle
DATA-02 et publie `pixel-processed` ou `pixel-rejected` avant le `204`.

Voir [contrats, configuration, reprise et tests](../../../docs/draw-worker.md).

## Carte des fichiers

- `src/message.ts` : validation du push et adaptation web/Discord.
- `src/processor.ts` : initialisation paresseuse du moteur DATA-02 avec Firestore.
- `src/result.ts` : enveloppe du résultat et ID stable.
- `src/publisher.ts` : publication confirmée dans le topic adapté.
- `src/index.ts` : handler, réponses et logs sûrs.
- `src/*.test.ts` : tests unitaires et HTTP réels.
- `../../testing/draw-worker.integration.test.ts` : Firestore + Pub/Sub émulateurs.

Le worker ne dessine pas une seconde fois sur une relivraison : DATA-02 reprend
son résultat conservé. Des publications répétées restent possibles avec le même
ID de résultat. Aucun appel Discord, déploiement Terraform ou activation du push
n'est inclus ; concurrence et maximum d'instances restent à valider en dev.
