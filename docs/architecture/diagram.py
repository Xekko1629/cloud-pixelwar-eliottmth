#!/usr/bin/env python3
"""Architecture diagram of Pixel War, as code (ARCH-02, DOC-02).

One model below lists every component and flow. Each component names the Terraform
addresses that implement it; the status of a component is read from the Terraform code:

- "deployed": every listed address is declared in its stack (solid);
- "planned": an address is missing (dashed, grey, "prévu");
- "external": outside our Terraform (Discord, GitHub, the browser, managed services).

Usage (from the repository root):
  python docs/architecture/diagram.py           # architecture.json + PNG views (needs Graphviz + diagrams)
  python docs/architecture/diagram.py --check   # CI: no forgotten component, architecture.json up to date

The check needs only the Python standard library.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = Path(__file__).resolve().parent
MANIFEST = OUT / 'architecture.json'

# Terraform objects that are architecture components: each one declared in a stack must be
# drawn, otherwise --check fails. IAM bindings, sources and subscriptions are not components.
TRACKED_RESOURCES = {
    'google_artifact_registry_repository', 'google_billing_budget', 'google_cloud_run_v2_service',
    'google_cloud_scheduler_job', 'google_compute_network', 'google_container_cluster',
    'google_container_node_pool', 'google_firebaserules_release', 'google_firestore_database',
    'google_iam_workload_identity_pool', 'google_monitoring_alert_policy', 'google_monitoring_dashboard',
    'google_secret_manager_secret', 'google_storage_bucket', 'helm_release',
}
TRACKED_MODULE_SOURCES = ('modules/function', 'modules/pubsub-topic', 'modules/api-gateway')


@dataclass(frozen=True)
class Component:
    id: str
    label: str
    icon: str          # module.Class of the diagrams package
    view: str          # 'application' or 'plateforme'
    group: str
    terraform: tuple[str, ...] = ()   # 'stack:address'; empty = external
    note: str = ''     # second line: identity, role or limit


@dataclass(frozen=True)
class Flow:
    source: str
    target: str
    label: str
    kind: str = 'request'   # request | event | read | secret | deploy
    layout: bool = True     # False: drawn, but ignored when Graphviz ranks the columns


C = Component
COMPONENTS = [
    # --- Application: users and entry points -------------------------------------------------
    C('discord', 'Discord', 'saas.chat.Discord', 'application', 'Utilisateurs'),
    C('browser', 'Navigateur', 'onprem.client.Users', 'application', 'Utilisateurs', note='React + canvas'),
    C('discord_api', 'API Discord', 'saas.chat.Discord', 'application', 'Réponses',
      note='réponses aux interactions'),
    C('frontend', 'frontend', 'gcp.compute.Run', 'application', 'Entrée publique',
      ('frontend:google_cloud_run_v2_service.frontend',), 'Cloud Run nginx · SA frontend (aucun rôle)'),
    C('gateway', 'API Gateway', 'gcp.api.APIGateway', 'application', 'Entrée publique',
      ('gateway:module.api_gateway',), 'JWT de session · SA pixelwar-gateway'),
    # --- Proxies -------------------------------------------------------------------------------
    C('warmup', 'Cloud Scheduler', 'gcp.devtools.Scheduler', 'application', 'Entrée publique',
      ('gateway:google_cloud_scheduler_job.gateway_warmup',), 'GET /discord/health toutes les 5 min'),
    C('discord_proxy', 'discord-proxy', 'gcp.compute.Run', 'application', 'Proxies (Cloud Run functions)',
      ('serverless:module.discord_proxy',), 'Go · vérifie Ed25519 · SA discord-proxy'),
    C('discord_hello', 'discord-hello', 'gcp.compute.Run', 'application', 'Proxies (Cloud Run functions)',
      ('serverless:module.discord_hello',), 'sonde C05 · SA discord-hello'),
    C('web_proxy', 'web-proxy', 'gcp.compute.Run', 'application', 'Proxies (Cloud Run functions)',
      ('serverless:module.web_proxy',), '1 événement par pixel · SA web-proxy'),
    C('auth_proxy', 'auth-proxy', 'gcp.compute.Run', 'application', 'Proxies (Cloud Run functions)',
      ('serverless:module.auth_proxy',), 'OAuth2 Discord (échange du code) · SA auth-proxy'),
    C('tile_reader', 'tile-reader', 'gcp.compute.Run', 'application', 'Proxies (Cloud Run functions)',
      ('serverless:module.tile_reader',), 'lectures · SA tile-reader (datastore.viewer)'),
    C('session_signer', 'session-signer', 'gcp.security.Iam', 'application', 'Proxies (Cloud Run functions)',
      ('serverless:google_service_account.session_signer',), 'signJwt · aucun rôle'),
    # --- Pub/Sub ---------------------------------------------------------------------------------
    C('t_discord_command', 'discord-command', 'gcp.analytics.PubSub', 'application', 'Pub/Sub · entrée',
      ('serverless:module.discord_commands',)),
    C('t_dlq', 'DLQ', 'gcp.analytics.PubSub', 'application', 'Pub/Sub · entrée',
      ('serverless:module.command_worker_subscription',), 'une par abonnement · alerte si > 0'),
    C('t_pixel_draw', 'pixel-draw', 'gcp.analytics.PubSub', 'application', 'Pub/Sub · entrée',
      ('serverless:module.pixel_draw',), '1 message = 1 pixel'),
    C('t_pixel_result', 'pixel-processed / rejected', 'gcp.analytics.PubSub', 'application',
      'Pub/Sub · suites', ('serverless:module.pixel_processed', 'serverless:module.pixel_rejected')),
    C('t_admin', 'admin-requested / command-rejected', 'gcp.analytics.PubSub', 'application', 'Pub/Sub · suites',
      ('serverless:module.admin_requested', 'serverless:module.command_rejected'), '/admin autorisé ou refusé'),
    C('t_render', 'render-requested', 'gcp.analytics.PubSub', 'application', 'Pub/Sub · suites',
      ('serverless:module.render_requested',)),
    C('t_snapshot', 'snapshot-requested', 'gcp.analytics.PubSub', 'application', 'Pub/Sub · suites',
      ('serverless:module.snapshot_requested',)),
    C('t_snapshot_ready', 'snapshot-ready', 'gcp.analytics.PubSub', 'application', 'Pub/Sub · suites',
      ('serverless:module.snapshot_ready',), 'notification OBJECT_FINALIZE'),
    C('t_overview', 'overview-tick', 'gcp.analytics.PubSub', 'application', 'Pub/Sub · suites',
      ('serverless:module.overview_tick',)),
    C('scheduler', 'Cloud Scheduler', 'gcp.devtools.Scheduler', 'application', 'Pub/Sub · suites',
      ('serverless:google_cloud_scheduler_job.overview_tick',), 'chaque minute'),
    # --- Workers ---------------------------------------------------------------------------------
    C('command_worker', 'command-worker', 'gcp.compute.Run', 'application', 'Workers · étape 1 (ingress interne)',
      ('serverless:module.command_worker',), 'commandes + droits admin'),
    C('draw_worker', 'draw-worker', 'gcp.compute.Run', 'application', 'Workers · étape 1 (ingress interne)',
      ('serverless:module.draw_worker',), 'pause, quota, LWW, deltas'),
    C('discord_notifier', 'discord-notifier', 'gcp.compute.Run', 'application', 'Workers · étape 2 (ingress interne)',
      ('serverless:module.discord_notifier',)),
    C('admin_worker', 'admin-worker', 'gcp.compute.Run', 'application', 'Workers · étape 2 (ingress interne)',
      ('serverless:module.admin_worker',), 'pause, clear, quota, taille'),
    C('render_worker', 'render-worker', 'gcp.compute.Run', 'application', 'Workers · étape 2 (ingress interne)',
      ('serverless:module.render_worker',), '/get : PNG'),
    C('snapshot_worker', 'snapshot-worker', 'gcp.compute.Run', 'application', 'Workers · étape 2 (ingress interne)',
      ('serverless:module.snapshot_worker',)),
    C('snapshot_notifier', 'snapshot-notifier', 'gcp.compute.Run', 'application', 'Workers · étape 2 (ingress interne)',
      ('serverless:module.snapshot_notifier',), 'URL signée'),
    C('overview_worker', 'overview-worker', 'gcp.compute.Run', 'application', 'Workers · étape 2 (ingress interne)',
      ('serverless:module.overview_worker',), 'vue éloignée'),
    # --- Data --------------------------------------------------------------------------------------
    C('firestore', 'Firestore', 'gcp.database.Firestore', 'application', 'Données',
      ('serverless:google_firestore_database.main',), 'tuiles 64×64, deltas, quotas, config'),
    C('rules', 'Security Rules', 'gcp.security.Iam', 'application', 'Données',
      ('serverless:google_firebaserules_release.firestore',), 'lecture seule : deltas, config/global'),
    C('b_snapshots', 'bucket snapshots', 'gcp.storage.GCS', 'application', 'Données',
      ('serverless:google_storage_bucket.application',), 'privé'),
    C('b_overview', 'bucket overview', 'gcp.storage.GCS', 'application', 'Données',
      ('serverless:google_storage_bucket.application',), 'privé'),
    C('secrets', 'Secret Manager', 'gcp.security.SecretManager', 'application', 'Données',
      ('iam:google_secret_manager_secret.application',), 'lu par les proxies Discord et auth,\npar les workers Discord et admin (IAM par secret)'),
    # --- Observability -------------------------------------------------------------------------------
    C('telemetry', 'Logging / Monitoring / Trace', 'gcp.operations.Monitoring', 'application', 'Observabilité',
      note='logs JSON + OTLP, correlation_id'),
    C('alerts', 'Alertes et dashboards', 'gcp.operations.Logging', 'application', 'Observabilité',
      ('*:google_monitoring_alert_policy.*', '*:google_monitoring_dashboard.*')),

    # --- Platform: delivery ----------------------------------------------------------------------
    C('github', 'GitHub', 'onprem.vcs.Github', 'plateforme', 'GitHub', note='PR, review, tags vX.Y.Z'),
    C('actions', 'GitHub Actions', 'onprem.ci.GithubActions', 'plateforme', 'GitHub', note='CI (plan) · deploy (apply)'),
    C('humans', 'Équipe + encadrant', 'onprem.client.Users', 'plateforme', 'GitHub',
      ('access:google_project_iam_member.editor',), 'stack access (séparé)'),
    C('wif', 'Workload Identity Federation', 'gcp.security.Iam', 'plateforme', 'Identités (stack iam)',
      ('iam:google_iam_workload_identity_pool.github',), 'repo + environnement'),
    C('deployer', 'SA deployer / planner', 'gcp.security.Iam', 'plateforme', 'Identités (stack iam)',
      ('iam:google_service_account.deployer', 'iam:google_service_account.planner'), 'sans clé longue durée'),
    C('budget', 'Budget', 'gcp.management.Billing', 'plateforme', 'Identités (stack iam)',
      ('iam:google_billing_budget.project',), 'alertes de coût'),
    C('tfstate', 'state Terraform', 'gcp.storage.GCS', 'plateforme', 'Identités (stack iam)',
      ('iam:google_storage_bucket.tfstate',), 'GCS, verrouillé'),
    C('ci_secrets', 'Secret Manager', 'gcp.security.SecretManager', 'plateforme', 'Identités (stack iam)',
      ('iam:google_secret_manager_secret.arc_github_app',), 'GitHub App des runners'),
    C('registry', 'Artifact Registry', 'gcp.devtools.ContainerRegistry', 'plateforme', 'Build (stack bootstrap)',
      ('bootstrap:google_artifact_registry_repository.containers',), 'image frontend par digest'),
    C('sources', 'sources des fonctions', 'gcp.storage.GCS', 'plateforme', 'Build (stack bootstrap)',
      ('bootstrap:google_storage_bucket.function_sources',), 'ZIP SHA-256'),
    C('cloudbuild', 'Cloud Build', 'gcp.devtools.Build', 'plateforme', 'Build (stack bootstrap)',
      ('bootstrap:google_service_account.function_builder',), 'SA function-builder'),
    C('vpc', 'VPC + sous-réseau', 'gcp.network.VPC', 'plateforme', 'Foundation',
      ('foundation:google_compute_network.main',)),
    C('gke', 'GKE', 'gcp.compute.GKE', 'plateforme', 'Foundation',
      ('foundation:google_container_cluster.main',), 'pool system : 1 à 2 nœuds'),
    C('runner_pool', 'pool runners', 'gcp.compute.GKE', 'plateforme', 'Foundation',
      ('foundation:google_container_node_pool.runners', 'foundation:google_container_node_pool.system'),
      'autoscaling 0 à 6 nœuds'),
    C('arc', 'ARC + runners', 'k8s.compute.Pod', 'plateforme', 'Foundation',
      ('runners:helm_release.arc_controller', 'runners:helm_release.arc_runner_set'), 'Helm, label RUNNER_LABEL'),
    C('eso', 'External Secrets', 'k8s.podconfig.Secret', 'plateforme', 'Foundation',
      ('runners:helm_release.external_secrets', 'runners:helm_release.arc_github_secret'), 'Workload Identity'),
    C('cluster_monitoring', 'Cloud Monitoring', 'gcp.operations.Monitoring', 'plateforme', 'Foundation',
      note='métriques GKE natives'),
    C('application', 'Application serverless', 'gcp.compute.Run', 'plateforme', 'Projet dev / prd',
      ('serverless:google_firestore_database.main', 'gateway:module.api_gateway'), 'voir vue application'),
]

F = Flow
FLOWS = [
    # Requests
    F('discord', 'gateway', 'HTTPS POST /discord/interactions'),
    F('browser', 'frontend', 'HTTPS (fichiers statiques)'),
    F('browser', 'gateway', 'HTTPS + JWT de session'),
    F('gateway', 'discord_proxy', 'ID token Google (run.invoker)'),
    F('warmup', 'gateway', 'garde chaud', layout=False),
    F('gateway', 'discord_hello', 'ID token Google'),
    F('gateway', 'web_proxy', 'POST /api/pixels (1 à 500)'),
    F('gateway', 'auth_proxy', '/auth/login, /auth/exchange'),
    F('gateway', 'tile_reader', 'GET /api/regions, /api/state'),
    F('auth_proxy', 'session_signer', 'signJwt', layout=False),
    # Events
    F('discord_proxy', 't_discord_command', 'publish', 'event'),
    F('web_proxy', 't_pixel_draw', 'publish × N', 'event'),
    F('t_discord_command', 'command_worker', 'push OIDC', 'event'),
    F('command_worker', 't_pixel_draw', '/draw', 'event'),
    F('command_worker', 't_render', '/get', 'event'),
    F('command_worker', 't_admin', '/admin', 'event'),
    F('t_admin', 'admin_worker', 'push OIDC', 'event'),
    F('t_admin', 'discord_notifier', 'refus : push OIDC', 'event', layout=False),
    F('admin_worker', 'firestore', 'config/global, quotas, purge'),
    F('admin_worker', 'discord_api', 'HTTPS PATCH (réponse)', layout=False),
    F('command_worker', 't_snapshot', '/snapshot', 'event'),
    F('t_pixel_draw', 'draw_worker', 'push OIDC', 'event'),
    F('draw_worker', 'firestore', 'transaction : tuile + delta + quota'),
    F('draw_worker', 't_pixel_result', 'publish', 'event'),
    F('t_pixel_result', 'discord_notifier', 'push OIDC', 'event'),
    F('t_render', 'render_worker', 'push OIDC', 'event'),
    F('render_worker', 'firestore', 'config/global, tuiles (lecture)'),
    F('render_worker', 'discord_api', 'HTTPS PATCH + PNG', layout=False),
    F('t_snapshot', 'snapshot_worker', 'push OIDC', 'event'),
    F('snapshot_worker', 'b_snapshots', 'PNG horodaté'),
    F('b_snapshots', 't_snapshot_ready', 'OBJECT_FINALIZE', 'event', layout=False),
    F('t_snapshot_ready', 'snapshot_notifier', 'push OIDC', 'event'),
    F('scheduler', 't_overview', 'publish', 'event'),
    F('t_overview', 'overview_worker', 'push OIDC', 'event'),
    F('overview_worker', 'b_overview', 'images basse résolution'),
    F('overview_worker', 'firestore', 'deltas et tuiles (lecture)', 'read', layout=False),
    F('tile_reader', 'b_overview', 'URL signées (15 min)', 'read', layout=False),
    F('t_discord_command', 't_dlq', 'échecs répétés', 'event', layout=False),
    # Replies to Discord
    F('discord_notifier', 'discord_api', 'HTTPS PATCH (réponse)'),
    F('render_worker', 'discord_api', 'HTTPS (image)'),
    F('snapshot_notifier', 'discord_api', 'HTTPS (URL signée)'),
    # Reads
    F('tile_reader', 'firestore', 'lecture (IAM)', 'read', layout=False),
    F('render_worker', 'firestore', 'lecture', 'read', layout=False),
    F('browser', 'rules', 'onSnapshot : deltas, config', 'read', layout=False),
    F('rules', 'firestore', 'lecture seule', 'read'),
    # Platform
    F('humans', 'github', 'PR signées'),
    F('github', 'actions', 'PR → plan, tag → apply'),
    F('actions', 'wif', 'token OIDC', 'deploy'),
    F('wif', 'deployer', 'credentials courts', 'deploy'),
    F('deployer', 'tfstate', 'state', 'deploy'),
    F('deployer', 'registry', 'push image', 'deploy'),
    F('deployer', 'sources', 'ZIP', 'deploy'),
    F('sources', 'cloudbuild', 'build', 'deploy'),
    F('deployer', 'gke', 'terraform + helm', 'deploy'),
    F('deployer', 'application', 'terraform apply dev → prd', 'deploy'),
    F('vpc', 'gke', 'réseau', 'read'),
    F('gke', 'runner_pool', 'node pools', 'read'),
    F('runner_pool', 'arc', 'pods runners', 'read'),
    F('ci_secrets', 'eso', 'GitHub App', 'secret'),
    F('eso', 'arc', 'secret k8s', 'secret'),
    F('arc', 'actions', 'jobs (runs-on)', layout=False),
    F('gke', 'cluster_monitoring', 'métriques', 'read'),
]


# --- Terraform inventory ----------------------------------------------------------------------

HEADER = re.compile(r'^(resource|module)\s+"([^"]+)"(?:\s+"([^"]+)")?')
SOURCE = re.compile(r'^\s*source\s*=\s*"([^"]+)"')


def terraform_inventory() -> dict[str, dict[str, str]]:
    """stack -> {address: module source or resource type}, top-level .tf files only."""
    inventory: dict[str, dict[str, str]] = {}
    for stack_dir in sorted((ROOT / 'infra').iterdir()):
        if not stack_dir.is_dir():
            continue
        found: dict[str, str] = {}
        for tf in sorted(stack_dir.glob('*.tf')):
            lines = [l for l in tf.read_text(encoding='utf-8').splitlines() if not l.lstrip().startswith(('#', '//'))]
            for i, line in enumerate(lines):
                match = HEADER.match(line)
                if not match:
                    continue
                kind, first, second = match.groups()
                if kind == 'module':
                    source = next((m.group(1) for l in lines[i + 1:i + 6] if (m := SOURCE.match(l))), '')
                    found[f'module.{first}'] = source
                else:
                    found[f'{first}.{second}'] = first
        inventory[stack_dir.name] = found
    return inventory


def declared(reference: str, inventory: dict[str, dict[str, str]]) -> bool:
    stack, address = reference.split(':', 1)
    stacks = inventory.values() if stack == '*' else [inventory.get(stack, {})]
    pattern = re.compile('^' + re.escape(address).replace(r'\*', '.*') + '$')
    return any(pattern.match(a) for found in stacks for a in found)


def status(component: Component, inventory) -> str:
    if not component.terraform:
        return 'external'
    if component.id == 'alerts':  # any alert policy or dashboard is enough
        return 'deployed' if any(declared(r, inventory) for r in component.terraform) else 'planned'
    return 'deployed' if all(declared(r, inventory) for r in component.terraform) else 'planned'


def tracked(inventory) -> set[str]:
    result = set()
    for stack, found in inventory.items():
        for address, source in found.items():
            if address.startswith('module.'):
                if source.endswith(TRACKED_MODULE_SOURCES):
                    result.add(f'{stack}:{address}')
            elif source in TRACKED_RESOURCES:
                result.add(f'{stack}:{address}')
    return result


def manifest(inventory) -> dict:
    statuses = {c.id: status(c, inventory) for c in COMPONENTS}

    def flow_status(f: Flow) -> str:
        return 'planned' if 'planned' in (statuses[f.source], statuses[f.target]) else 'deployed'

    return {
        'generated_by': 'docs/architecture/diagram.py',
        'components': [
            {'id': c.id, 'label': c.label, 'view': c.view, 'group': c.group,
             'status': statuses[c.id], 'terraform': list(c.terraform)}
            for c in COMPONENTS
        ],
        'flows': [
            {'from': f.source, 'to': f.target, 'label': f.label, 'kind': f.kind, 'status': flow_status(f)}
            for f in FLOWS
        ],
    }


def check(inventory) -> list[str]:
    errors = []
    ids = {c.id for c in COMPONENTS}
    errors += [f'flux {f.source} -> {f.target} : composant inconnu' for f in FLOWS
               if f.source not in ids or f.target not in ids]
    drawn = {r for c in COMPONENTS for r in c.terraform}
    for reference in sorted(tracked(inventory)):
        stack, address = reference.split(':', 1)
        # Is this declared object covered by a reference of the model (same stack or '*')?
        if not any(declared(d.replace('*:', f'{stack}:', 1), {stack: {address: ''}}) for d in drawn):
            errors.append(f'{reference} est déclaré dans Terraform mais absent du diagramme')
    expected = json.dumps(manifest(inventory), ensure_ascii=False, indent=2) + '\n'
    current = MANIFEST.read_text(encoding='utf-8') if MANIFEST.exists() else ''
    if current.replace('\r\n', '\n') != expected:
        errors.append(f'{MANIFEST.relative_to(ROOT).as_posix()} n\'est pas à jour : lancer `just diagram`')
    return errors


# --- Rendering ---------------------------------------------------------------------------------

EDGE_STYLE = {
    'request': {'color': '#1A73E8'},
    'event': {'color': '#E37400'},
    'read': {'color': '#188038'},
    'secret': {'color': '#9334E6', 'style': 'dotted'},
    'deploy': {'color': '#5F6368'},
}
GROUP_STYLE = {'bgcolor': '#F8F9FA', 'pencolor': '#DADCE0', 'fontsize': '15', 'fontname': 'Helvetica-Bold',
               'margin': '18'}
GRAPH = {'fontname': 'Helvetica', 'fontsize': '22', 'pad': '0.6', 'nodesep': '0.55', 'ranksep': '1.1',
         'splines': 'spline', 'dpi': '110', 'labelloc': 't'}
NODE = {'fontname': 'Helvetica', 'fontsize': '12'}
EDGE = {'fontname': 'Helvetica', 'fontsize': '10'}


def render(view: str, title: str, filename: str, inventory, direction: str) -> None:
    import importlib

    from diagrams import Cluster, Diagram, Edge

    statuses = {c.id: status(c, inventory) for c in COMPONENTS}
    nodes = {}
    with Diagram(title, filename=str(OUT / filename), outformat='png', show=False, direction=direction,
                 graph_attr=GRAPH, node_attr=NODE, edge_attr=EDGE):
        groups: dict[str, list[Component]] = {}
        for component in (c for c in COMPONENTS if c.view == view):
            groups.setdefault(component.group, []).append(component)
        for group, members in groups.items():
            with Cluster(group, graph_attr=GROUP_STYLE):
                for c in members:
                    module, cls = c.icon.rsplit('.', 1)
                    icon = getattr(importlib.import_module(f'diagrams.{module}'), cls)
                    lines = [c.label] + ([c.note] if c.note else [])
                    attrs = {}
                    if statuses[c.id] == 'planned':
                        lines.append('(prévu)')
                        attrs = {'fontcolor': '#80868B', 'shape': 'box', 'style': 'dashed,rounded',
                                 'color': '#9AA0A6', 'penwidth': '1.4', 'imagepos': 'tc', 'labelloc': 'b'}
                    nodes[c.id] = icon('\n'.join(lines), **attrs)
        for f in FLOWS:
            if f.source not in nodes or f.target not in nodes:
                continue
            attrs = dict(EDGE_STYLE[f.kind])
            if not f.layout or f.kind == 'secret':
                attrs['constraint'] = 'false'
            if 'planned' in (statuses[f.source], statuses[f.target]):
                attrs.update({'style': 'dashed', 'color': '#BDC1C6', 'fontcolor': '#80868B'})
            nodes[f.source] >> Edge(label=f.label, **attrs) >> nodes[f.target]


def main() -> int:
    sys.stdout.reconfigure(encoding='utf-8')
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--check', action='store_true', help='verify only, without Graphviz')
    args = parser.parse_args()
    inventory = terraform_inventory()
    if args.check:
        errors = check(inventory)
        for error in errors:
            print(f'::error::{error}')
        print('Diagramme conforme au code Terraform.' if not errors else f'{len(errors)} écart(s).')
        return 1 if errors else 0
    MANIFEST.write_text(json.dumps(manifest(inventory), ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    status_legend = 'trait plein : déclaré dans Terraform · pointillé gris : prévu'
    render('application', 'Pixel War · application serverless\n'
           f'{status_legend} · bleu : requêtes · orange : événements · vert : lectures',
           'pixelwar-application', inventory, 'LR')
    render('plateforme', 'Pixel War · socle, CI/CD et runners\n'
           f'{status_legend} · gris : déploiement · vert : infrastructure · violet : secrets',
           'pixelwar-plateforme', inventory, 'LR')
    print(f'Généré : {MANIFEST.name}, pixelwar-application.png, pixelwar-plateforme.png')
    return 0


if __name__ == '__main__':
    sys.exit(main())
