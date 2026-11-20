# Discord notifier

Entrée HTTP Node.js 24 : `handleDiscordNotifier`. Consomme les résultats de
dessin et modifie la réponse différée Discord via PATCH sur `@original`.

Voir [contrat, configuration et politique d'expiration](../../../docs/discord-notifier.md).

## Fichiers

- `src/message.ts` : validation indépendante des résultats et du contexte Discord.
- `src/content.ts` : messages déterministes et mentions désactivées.
- `src/discord.ts` : PATCH borné, sans redirection, expiration et erreurs assainies.
- `src/index.ts` : configuration, logs sûrs et acquittement.
- `src/*.test.ts` : tests unitaires et HTTP avec une fausse API Discord locale.
- `../../testing/discord-draw-pipeline.integration.test.ts` : parcours applicatif
  complet sur émulateurs jusqu'au message local.

Les doublons réécrivent le même message ; aucun POST de suivi n'est utilisé.
Après 15 minutes : log d'expiration puis acquittement, sans appel Discord.
Aucun token bot, SDK Discord, Firestore ou nouveau stockage n'est nécessaire.
Les ressources Terraform/IAM et l'essai dev réel restent séparés.
