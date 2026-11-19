# Maintenance des diagrammes

## Consultation et périmètre

Les vues sont présentées dans le [guide d'architecture](../architecture.md).

## Vues Archify

Ouvrir les fichiers HTML dans un navigateur : aucun serveur ni accès GCP n'est
nécessaire. GitHub affiche leur source HTML, pas le lecteur interactif ; télécharger
le fichier ou utiliser une copie locale du dépôt pour consulter le diagramme.

Les fichiers JSON sont les sources éditables ; les fichiers HTML sont les rendus
autonomes à régénérer après modification. Ne pas modifier les HTML à la main.

## Références au code

Chaque spécification fixe la révision Git dans `meta.repository.revision` et
associe aux composants des références `sources` avec chemin et lignes. Ces
références décrivent le code de cette révision, pas les ressources déployées.
Le mode `local-only` permet la vérification depuis le dépôt local sans supposer
que le commit est disponible sur GitHub.

Lors d'une évolution du code, relire les contrats concernés, mettre à jour les
références et la révision après le commit du code, puis régénérer les vues.
Ne pas remplacer uniquement la révision sans vérifier les chemins et les lignes.

## Régénération et vérification

Prérequis : Node.js, Archify installé et un navigateur Chrome/Chromium compatible
avec ses contrôles. Les rendus sont produits avec Archify 3.2.0. L'outil n'est
pas une dépendance de l'application et sa génération ne déploie aucune ressource.

Depuis la racine du dépôt, définir `ARCHIFY_CLI` avec le chemin absolu vers
`bin/archify.mjs` dans l'installation locale. Définir `ARCHIFY_REVIEW_DIR` vers
un **nouveau dossier hors du dépôt** pour chaque passe de génération.

```bash
: "${ARCHIFY_CLI:?Définir le chemin absolu vers bin/archify.mjs}"
: "${ARCHIFY_REVIEW_DIR:?Définir un nouveau dossier hors du dépôt}"
mkdir -p "$ARCHIFY_REVIEW_DIR"

for vue in parcours-discord socle-deploiement sequence-callback; do
  type=architecture
  if [ "$vue" = sequence-callback ]; then
    type=sequence
  fi
  node "$ARCHIFY_CLI" finalize "$type" \
    "docs/architecture/$vue.json" "docs/architecture/$vue.html" \
    --repo-root "$PWD" --quality showcase \
    --out-dir "$ARCHIFY_REVIEW_DIR/$vue" --json || exit 1
done
```

Exécuter les générations successivement : Archify verrouille le répertoire de
livraison. Une sortie non nulle n'est pas une validation ; examiner le diagnostic
avant de poursuivre. Un succès couvre la spécification, la livraison, les
contrôles de l'artefact et le contrôle navigateur automatisé, pas une revue
visuelle humaine. Ouvrir ensuite les vues pour relire les libellés et les trajets.

Les rapports de vérification restent hors du dépôt technique. Archify écrit
aussi un reçu `*.delivery.json` à côté de chaque HTML : après les contrôles,
déplacer ces reçus vers le dossier de revue. Pour Archify, versionner les sources
JSON et les rendus HTML, pas les rapports ou captures de contrôle locaux.

## Architecture générale Draw.io

### Sources, périmètre et logos

- `pixelwar.drawio` : diagramme natif éditable de trois pages, sans image aplatie
  à la place des composants ou des connecteurs.
- `pixelwar.ir.json` : modèle Diagram IR v1, avec composants, relations, pages,
  rangs de placement, sources et logos embarqués.
- `render-pixelwar.py` : génération depuis le modèle via `diagramctl.py build`
  et le moteur Graphviz d'autolayout de drawio-skill.
- `pixelwar-actuel.png`, `pixelwar-cible.png`, `pixelwar-plateforme.png` : aperçus
  non éditables issus du lecteur Draw.io dans Chromium, pas d'un moteur de dessin
  indépendant.

Le modèle cite la révision du code et les URLs des tickets ; les noms des pages
ne décrivent pas l'état réel des projets GCP. La vue actuelle distingue une
bibliothèque testée d'un handler HTTP. La cible décrit les contrats retenus et
signale les propositions ou arbitrages restants. Les propriétés intégrées aux
composants conservent leur provenance, sans secrets ni copie des corps de tickets.

Les formes GCP et GitHub proviennent de la bibliothèque Draw.io ; les recherches
de logos ont été vérifiées avec le MCP Draw.io. Les SVG de Firebase et Terraform
et le logo Discord de Simple Icons sont embarqués avec leur URL d'origine dans
le modèle. Les logos servent à identifier les technologies, pas à revendiquer
une affiliation. Un pictogramme générique n'est pas une technologie supplémentaire.

### Génération et contrôles

Prérequis : Python 3, Graphviz (`dot`) et une installation de drawio-skill.
Définir `DRAWIO_SKILL_DIR` avec le chemin de cette installation.

```bash
: "${DRAWIO_SKILL_DIR:?Définir le répertoire de drawio-skill}"
python3 docs/architecture/render-pixelwar.py \
  --skill-dir "$DRAWIO_SKILL_DIR" \
  --output docs/architecture/pixelwar.next.drawio
python3 "$DRAWIO_SKILL_DIR/scripts/validate.py" \
  docs/architecture/pixelwar.next.drawio --score
python3 "$DRAWIO_SKILL_DIR/scripts/diagramctl.py" test \
  docs/architecture/pixelwar.next.drawio
```

Comparer le résultat avec la version existante avant de la remplacer. La
génération recalcule la géométrie : elle ne conserve pas les retouches manuelles
faites dans Draw.io. Garder ces retouches dans une copie et utiliser le workflow
`sync` de drawio-skill pour une réconciliation, puis vérifier les trois pages.
Les identifiants des composants et les propriétés `data-model-id` servent à
retrouver les mêmes éléments dans les différentes vues.

Le linter signale les croisements ; les règles sémantiques génériques peuvent
aussi signaler les retours requête/réponse comme cycles ou les logos comme
éléments isolés. Examiner ces avertissements dans leur contexte : ce ne sont ni
des preuves de défaut applicatif ni des validations de sécurité IAM. Contrôler
aussi les chemins des flèches, les libellés et les propositions signalées dans le
rendu réel. Conserver les rapports de contrôle hors du dépôt.

### Actualisation des aperçus

Sans CLI desktop, ouvrir chaque page dans le lecteur Draw.io puis exporter ou
capturer la page entière à une définition permettant de lire les libellés.
Vérifier que le navigateur a rendu les logos et que le bas de page n'est pas
tronqué. Les PNG ne sont pas régénérés par le script Python.

Avec le CLI desktop disponible, exporter chaque page séparément ; l'index est
zéro-based (`0`, `1`, `2`). Résoudre le chemin absolu du binaire avant l'export :

```bash
: "${DRAWIO_CLI:?Définir le chemin absolu du CLI Draw.io}"
"$DRAWIO_CLI" -x -f png --page-index 0 -s 2 \
  -o docs/architecture/pixelwar-actuel.png docs/architecture/pixelwar.drawio
"$DRAWIO_CLI" -x -f png --page-index 1 -s 2 \
  -o docs/architecture/pixelwar-cible.png docs/architecture/pixelwar.drawio
"$DRAWIO_CLI" -x -f png --page-index 2 -s 2 \
  -o docs/architecture/pixelwar-plateforme.png docs/architecture/pixelwar.drawio
```

Ces PNG ne portent pas de XML embarqué : le `.drawio` reste la source éditable.
