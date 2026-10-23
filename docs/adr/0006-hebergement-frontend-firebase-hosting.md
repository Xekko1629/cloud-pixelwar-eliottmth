# ADR-0006 · Hébergement du frontend : Firebase Hosting

- **Statut** : Accepté
- **Date** : 2026-10-23
- **Tickets** : ARCH-01 (#26). Utilisé par WEB-01, SEC-01, SRV-02.
- **Références** : Sujet §3.4, §2.2 · C06 §4.1 · C07 §3.1, §5

## Contexte

- Le frontend doit être serverless. Le sujet cite comme exemples l'hébergement statique avec un CDN, Cloud Run, App Engine, CloudFront et Lambda@Edge, ou une Discord Activity (§3.4).
- C06 §4.1 et C07 §5 interdisent les buckets applicatifs publics, et SEC-01 vérifie qu'aucun bucket ni service Cloud Run n'a de binding `allUsers`.
- Tout doit être en HTTPS (§3.1), déployé en IaC par la pipeline, et un destroy ne doit rien laisser de facturable (§2.2).
- L'identité web repose sur Firebase Auth (ADR-0005), donc Firebase est déjà activé sur chaque projet.
- Le frontend est une application statique (HTML, JS, CSS). Il ne contient aucun secret : sa configuration (URL de la gateway, client id Discord, configuration web Firebase) est publique par nature.

## Décision

Le frontend est servi par **Firebase Hosting** : fichiers statiques derrière le CDN mondial de Google, en HTTPS avec un certificat géré, sur `<site>.web.app`.

- Un site par environnement, créé par Terraform (`google_firebase_hosting_site`, provider `google-beta`). On crée un site nommé plutôt que de s'appuyer sur le site par défaut du projet, pour qu'il soit supprimable par un destroy : à confirmer pendant WEB-01.
- Le contenu est publié par la pipeline sur tag, avec `firebase deploy --only hosting:<site>`, authentifié par Workload Identity (pas de clé). Terraform crée le site, mais ne sait pas en téléverser les fichiers.
- `firebase.json`, versionné, définit :
  - la réécriture de toutes les routes vers `index.html` (application monopage, dont `/auth/callback`) ;
  - les en-têtes de sécurité : `Content-Security-Policy` limité aux domaines de la gateway, de Firebase et de Discord, `Strict-Transport-Security`, `X-Content-Type-Options` ;
  - le cache : longue durée pour les fichiers dont le nom contient un hash, pas de cache pour `index.html`.
- La configuration de chaque environnement est injectée au moment du build (WEB-01).
- Aucune réécriture de Firebase Hosting vers Cloud Run : tous les appels d'API passent par la gateway.

## Options écartées

| Option | Pourquoi elle est écartée |
|---|---|
| Cloud Storage + Load Balancer + Cloud CDN | Le bucket doit être lisible par `allUsers` : c'est contraire à C06 §4.1 et ferait échouer SEC-01. Le Load Balancer est facturé même au repos (règle de transfert) dans chaque environnement, et un certificat géré demande un nom de domaine, que nous n'avons pas. |
| Cloud Run qui sert les fichiers statiques | Il faut `allUsers` sur le service, ce que SEC-01 interdit. Passer par API Gateway pour servir des fichiers statiques mélangerait les rôles, sans CDN, et chaque fichier compterait comme un appel d'API. Il y aurait aussi des cold starts sur la page d'accueil. |
| App Engine (standard, fichiers statiques) | Une application App Engine ne peut plus être supprimée d'un projet une fois créée, et sa région est figée : contraire à l'exigence d'une infrastructure jetable. |
| Discord Activity | Complexité supplémentaire (SDK embarqué, contraintes de Discord), pour un résultat qui doit de toute façon être hébergé quelque part. |

## Conséquences

**Ce qu'on y gagne**

- HTTPS, CDN, certificat et redirection HTTP vers HTTPS sans rien configurer.
- Aucun bucket public, aucun service Cloud Run public : SEC-01 reste vrai.
- Gratuit à l'échelle du projet (quotas gratuits de stockage et de transfert de Firebase Hosting).
- Même projet Firebase que l'authentification : la configuration web est la même pour les deux.

**Ce que ça coûte, et ce qu'il faut surveiller**

- Le déploiement du contenu passe par la CLI `firebase-tools` : c'est un outil de plus dans la pipeline (à justifier dans SEC-02, avec une version figée). Le deployer a besoin des droits Firebase Hosting.
- Firebase ne peut pas être retiré d'un projet une fois ajouté (ADR-0005) : `google_firebase_project` va dans le stack `bootstrap`. Le site Hosting, lui, reste dans le stack applicatif et se détruit avec lui.
- Firebase Hosting conserve les versions précédentes déployées : en limiter le nombre pour ne pas accumuler de stockage.
- La redirect URI Discord de chaque environnement est l'URL du site (`https://<site>.web.app/auth/callback`). Elle est enregistrée dans l'application Discord de cet environnement (BOT-01).

## En soutenance

- « Firebase Hosting, c'est de l'hébergement statique avec un CDN, comme le sujet le propose, avec HTTPS automatique. »
- « Les deux autres options demandaient de rendre un bucket ou un service Cloud Run public, ce qu'on s'interdit. »
- « App Engine a été écarté parce qu'on ne peut pas le supprimer d'un projet : l'infrastructure ne serait plus jetable. »
