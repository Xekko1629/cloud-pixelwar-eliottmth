# Réservation du quota web : `quota-reserver`

Fonction HTTP `app/functions/quota-reserver`, déployée par
`infra/serverless/quota-path.tf` avec le parcours web (`enable_web_api`). Décision :
[ADR-0017](adr/0017-quota-reserve-avant-publication.md).

## Rôle

`web-proxy` l'appelle **une fois par requête** `POST /api/pixels`, avant de publier,
pour réserver le quota de la requête. Le `draw-worker` ne recompte plus le quota d'un
pixel web : ses transactions n'écrivent plus `users/{uid}` quand le pixel est
accepté, ce qui supprime la contention mesurée le 27/11
([débit](draw-throughput.md)).

## Accès

| Contrôle | Valeur |
| --- | --- |
| Appelant autorisé | Le compte de service `web-proxy`, seul titulaire de `roles/run.invoker` sur le service |
| Autres appels, avec ou sans token | `403` de Cloud Run, avant le code |
| Route API Gateway | Aucune : absent de `gateway_contract` |
| Ingress | `ALLOW_ALL` : `web-proxy` n'a pas de sortie VPC, un ingress interne le refuserait aussi |
| Droits Firestore | `roles/datastore.user`, compte de service `quota-reserver` |

## Contrat

`POST /` avec `{ "reservation_id", "uid", "pixel_count" }` :

- `reservation_id` : le `correlation_id` de la requête web ;
- `uid` : l'identité donnée par la gateway ;
- `pixel_count` : de 1 à 500, la longueur du tableau validé par `web-proxy`.

Réponse `200` :

```json
{ "granted": 300, "refused": 200, "reason": "insufficient_quota", "retry_after_seconds": 40,
  "limit_per_minute": 1000, "remaining_pixels": 0, "reset_at": "2026-11-27T15:31:00.000Z" }
```

| Cas | `granted` | `reason` | Quota consommé |
| --- | --- | --- | --- |
| Quota suffisant | tous | — | tous |
| Quota partiel | les N restants : **les N premiers pixels** de la requête | `insufficient_quota` | N |
| Plus rien cette minute | 0 | `insufficient_quota`, avec `retry_after_seconds` | 0 |
| Limite nulle | 0 | `drawing_disabled` | 0 |
| Toile en pause | 0 | `paused` | 0 |

Autres réponses : `400 invalid_request`, `413 invalid_body_size`,
`404`, `405`, et `503 unavailable` si Firestore échoue. Les logs
(`quota.reserved`, `quota.refused`, `quota.failed`) portent le `correlation_id`,
jamais l'`uid`.

## Transaction

Une transaction (`createQuotaReservation`, `app/shared/src/drawing/reservation.ts`),
avec les reprises rapides de `runDrawTransaction` :

1. Lire `config/global`, `ratelimit_overrides/{uid}` et `users/{uid}`.
2. Si `users/{uid}.last_reservation.id` vaut `reservation_id`, rendre la réponse
   mémorisée : une reprise de `web-proxy` ne compte pas deux fois.
3. Calculer avec `evaluateRateLimit` (`docs/rate-limits.md`), d'abord pour tous les
   pixels, puis, s'ils ne tiennent pas, pour les pixels restants.
4. Écrire `users/{uid}` : compteur, `last_rejection` (`rate_limit` ou `paused`, ou
   `null` si tout est accordé) et `last_reservation`.

## Ce qui n'est pas remboursé

Un pixel accordé puis refusé par le `draw-worker` (pause activée entre-temps, pixel
trop vieux, hors de la toile) ou parti en DLQ garde son quota consommé (ADR-0017).

## Tests

- `app/shared/src/drawing/reservation.test.ts` : accord complet, partiel, nul, pause,
  limite nulle, override admin, reprise, racine isolée.
- `app/shared/src/drawing/reservation.integration.test.ts`, sur l'émulateur : six
  réservations simultanées d'un même joueur n'accordent jamais plus que sa limite,
  et une reprise simultanée ne compte qu'une fois.
- `app/functions/quota-reserver/src/index.test.ts` : codes HTTP, logs sans `uid`.
- `infra/serverless/tests/web-path.tftest.hcl` : invoker unique, rôle Firestore,
  URL donnée à `web-proxy`, absence de route gateway.
