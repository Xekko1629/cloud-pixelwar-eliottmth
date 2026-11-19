# Worker de diagnostic Discord (dev uniquement)

`handleDiscordCommandVerify` est un consommateur HTTP temporaire de
`discord-command` v1, distinct du futur `command-worker`. Il ne dessine pas,
ne consulte pas Firestore, ne débite aucun quota et n'appelle pas Discord.
Le code et les tests sont locaux. `infra/serverless/discord-command.tf` décrit
le raccordement dev : abonnement, IAM/OIDC, retries et DLQ. Aucun de ces éléments
n'a été provisionné par cette réalisation.

## Configuration future

| Variable | Valeur attendue |
| --- | --- |
| `APP_ENV` | `dev`, toute autre valeur désactive le handler |
| `DISCORD_APPLICATION_ID` | Application Discord attendue |
| `DISCORD_VERIFY_SUBSCRIPTION` | Nom complet `projects/<projet>/subscriptions/<abonnement>` |

Le worker accepte `POST /`. L'enveloppe Pub/Sub standard contient le JSON de
l'événement encodé en base64. La validation vérifie l'abonnement, l'identifiant
du message, le base64 canonique, l'UTF-8, le contrat v1, les bornes techniques,
l'application, la dérivation de l'UUIDv8 et de la date depuis l'interaction,
ainsi que la cohérence des attributs `correlation_id` et `traceparent`.
Les seuls attributs acceptés sont ceux du producteur actuel ; une évolution
du contrat nécessitera une revue de cette validation stricte.

Le corps brut est limité à 128 Kio et la chaîne base64 à 64 Kio. Functions
Framework a déjà parsé le JSON avant le handler : cette borne limite notre
travail de décodage, pas la mémoire consommée par le parseur HTTP en amont.
La validation du contrat est indépendante du code du proxy ; les tests utilisent
son producteur réel pour vérifier leur compatibilité. Le contrat reste à relire
avec Incognito avant tout raccordement cloud.

## Réponses et logs

- Valide : log `discord.command.verify.consumed`, puis `204` vide.
- Invalide : log `discord.command.verify.rejected` avec une catégorie fixe, puis `400`.
- Configuration indisponible ou erreur interne : `503`.
- Corps trop grand/absent : `413` ; mauvaise route : `404` ; méthode : `405`.

Seuls `event_id`, `correlation_id` et `message_id` validés sont journalisés en
cas de succès. Aucun corps, token, profil, attribut brut ou erreur brute n'est
journalisé. Les doublons sont acceptés et produisent plusieurs logs : ce worker
ne déduplique pas et ne prouve aucune idempotence métier.

Les réponses non réussies ne sont pas des acquittements Pub/Sub. Les futurs
retries et le transfert vers la DLQ nécessitent une configuration Terraform et
des droits IAM distincts ; le nombre de tentatives DLQ est approximatif.
Le message original contient le token d'interaction, y compris dans la DLQ :
accès restreints et rétention explicite seront indispensables.

## Sécurité et preuve

IAM/OIDC et l'ingress privé devront être imposés par l'infrastructure, pas par
ce parseur. Le champ `subscription` n'est pas une preuve d'authentification.
Le worker ne revérifie pas la signature Discord : la confiance dépend du proxy
et des droits publisher limités sur le topic. Ne pas exposer ce handler publiquement.

Depuis `app/` :

```bash
npm test -- functions/discord-command-verify
npm run typecheck
npm run build:functions -- discord-command-verify
```

Les tests unitaires et HTTP réels utilisent exclusivement des données fictives.
Ils prouvent la validation et les réponses, pas la livraison Pub/Sub ni IAM/OIDC.
