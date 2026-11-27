# Mesure du débit du parcours de dessin

## Objectif

Depuis l'[ADR-0014](adr/0014-un-evenement-par-pixel.md), chaque pixel est un message
`pixel-draw`. Le `draw-worker` en regroupe jusqu'à 32 par transaction
(`concurrency = 32`), avec au plus `draw_worker_max_instances` instances
([profil](draw-worker.md)). Cette mesure répond à deux
questions, en dev seulement :

- combien de pixels par seconde le parcours traite avec ce profil ;
- combien de temps attend un utilisateur dont le tracé fait 500 pixels, seul ou
  avec d'autres.

C'est une mesure ponctuelle, pas le test de charge de la démonstration : celui-ci
reste OBS-05a (k6 ou Locust), qui peut reprendre ce protocole.

## Outil

`app/tools/loadtest/` envoie des tracés sur `POST /api/pixels` par la gateway,
comme le navigateur, puis relit les logs `draw.result.published` du `draw-worker`.

```sh
cd app
npm run loadtest -- send --strokes 1 --pixels 500 --x 15000 --y 15000 --out ~/pixelwar-loadtest/run-500.json
# Attendre que l'abonnement draw-worker soit vide, puis lancer la commande gcloud affichée.
npm run loadtest -- report --run ~/pixelwar-loadtest/run-500.json --logs ~/pixelwar-loadtest/logs-500.json
```

- Tous les tracés partent en même temps, comme plusieurs navigateurs.
- Chaque tracé occupe 5 lignes de 100 pixels ; deux tracés sont espacés de 10 lignes.
- Le fichier du run contient les ids d'événements publiés, jamais le token. Il est
  créé avant l'envoi et n'écrase jamais un run précédent.
- Une erreur inattendue est remplacée par un texte fixe.

Le rapport donne, pour les pixels du run :

| Champ | Sens |
| --- | --- |
| `drain_seconds` | Du premier envoi au dernier pixel traité : l'attente de l'utilisateur |
| `pixels_per_second` | Pixels traités / `drain_seconds`, démarrage à froid compris |
| `steady_pixels_per_second` | Rythme entre le premier et le dernier pixel traité |
| `latency_seconds` | Par pixel, de l'envoi de son tracé à son traitement (p50, p95, max) |
| `pixels.rejected` | Refus métier (quota, pause…) : la mesure n'est valable qu'à 0 |
| `pixels.missing` | Pixels sans log : attendre, ou chercher dans la DLQ |
| `pixels.redelivered` | Relivraisons Pub/Sub du même pixel |

## Préparation

1. Relever sa limite : `/admin ratelimit` à 2000 pixels par minute. Le quota compte
   chaque pixel ([ADR-0014](adr/0014-un-evenement-par-pixel.md)) : sans cela, le
   21ᵉ pixel est refusé et la mesure est fausse.
2. Se connecter sur le frontend dev, puis copier le JWT de session depuis les outils
   du navigateur (`sessionStorage`, clé `pixelwar.session`, champ `token`). Il vaut
   15 minutes. Le saisir sans qu'il apparaisse à l'écran ni dans l'historique :

   ```sh
   read -rs PIXELWAR_SESSION_TOKEN && export PIXELWAR_SESSION_TOKEN
   export PIXELWAR_GATEWAY_URL=https://<defaultHostname de la gateway dev>
   ```

3. Dessiner dans un coin réservé (par exemple vers x = 15 000) : ces pixels
   agrandissent la zone peinte, donc l'image de `/get`.

## Paliers

| Palier | Commande | Ce qu'il montre |
| --- | --- | --- |
| 1 | `--strokes 1 --pixels 50` | Démarrage à froid, petit tracé |
| 2 | `--strokes 1 --pixels 500` | Un tracé maximal seul |
| 3 | `--strokes 4 --pixels 500` | Quatre utilisateurs en même temps (2000 pixels) |

Attendre la fin d'un palier, et une minute pour le quota, avant le suivant. Pendant
chaque palier, relever dans Cloud Monitoring les messages en attente de l'abonnement
`draw-worker` (`subscription/num_undelivered_messages`) et le nombre d'instances
du service `draw-worker`.

## Après la mesure

- Remettre la limite à sa valeur précédente avec `/admin ratelimit`.
- Si besoin, `/admin clear` pour effacer les pixels de test.
- Reporter les résultats datés ci-dessous. Changer `concurrency` est une décision
  séparée, avec sa propre PR. Pour la démonstration de montée en charge, refaire le
  palier 3 avec `draw_worker_max_instances` à 2, puis 4, puis 5, avec **quatre
  comptes différents**, et relever pour chaque valeur : débit, refus `429` de
  `draw-worker`, âge du plus vieux message, taille moyenne des groupes
  (`draw.group.committed`) et nombre de `draw.group.fallback`.

## Résultats

**27/11, 12:14–12:18 UTC, dev, `89eb0cc`, 2 instances, tracés au pinceau web** (pas
`npm run loadtest`) : 10 tracés, 2 385 pixels, tous traités, un résultat par pixel.

| Rafale | Pixels | Durée | Débit |
| --- | --- | --- | --- |
| 12:16:15, 4 tracés simultanés | 1 548 | 83 s | ≈ 19 px/s |
| 12:17:48, 3 tracés | 777 | 32 s | ≈ 24 px/s |

- 144 groupes, 16 pixels en moyenne, 31 au plus.
- Une requête occupe sa place 1,9 s en médiane (span `pixel-draw` : 1,7 s).
- 1 291 refus `429` « no available instance » : 2 instances × 32 places saturées ;
  les relivraisons Pub/Sub (10 à 60 s) font la traîne, jusqu'à 83 s après le clic.
- Nombre de comptes non relevé (`user_id` absent des logs de `web-proxy`).
