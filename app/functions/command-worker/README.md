# Command worker

Route les événements `discord-command` vers leur événement métier, sans dessiner
ni appeler Discord. Fonction HTTP privée attendue : `handleCommandWorker`.

Voir [le contrat, la configuration et les tests](../../../docs/command-worker.md).
Le worker de diagnostic `discord-command-verify` est conservé séparément.

## Fichiers

- `src/message.ts` : enveloppe push, validation et commandes acceptées.
- `src/route.ts` : routage pur et autorisation admin/snapshot.
- `src/publisher.ts` : publication Pub/Sub confirmée et bornée.
- `src/index.ts` : configuration, réponses HTTP et logs sûrs.
- `src/*.test.ts` : tests unitaires et HTTP Functions Framework.
- `../../testing/command-worker.integration.test.ts` : Pub/Sub émulateur.

## Limites de livraison

Les doublons peuvent produire plusieurs publications avec **le même ID métier**.
Chaque consommateur doit en dédupliquer les effets. Aucun déploiement Terraform
ni remplacement du worker de diagnostic n'est inclus. Les extensions de contrat
hors `/draw`, dont `admin-requested` et `command-rejected`, restent à faire relire
dans ARCH-03 avant raccordement des consommateurs.
