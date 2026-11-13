#!/usr/bin/env python3
"""Génère les pages Draw.io depuis pixelwar.ir.json, sans accès réseau ni GCP."""

import argparse
import copy
import html
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET


def cell_text(root, id, value, x, y, width, height, size=14, bold=False):
    cell = ET.SubElement(root, 'mxCell', {
        'id': id, 'value': value, 'vertex': '1', 'parent': '1',
        'style': 'text;html=1;whiteSpace=wrap;align=left;verticalAlign=top;'
                 f'fontFamily=Helvetica;fontSize={size};fontStyle={int(bold)};'
                 'fontColor=#243247;strokeColor=none;fillColor=none;',
    })
    ET.SubElement(cell, 'mxGeometry', {
        'x': str(x), 'y': str(y), 'width': str(width), 'height': str(height),
        'as': 'geometry',
    })


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--skill-dir', type=Path, required=True,
                        help='Répertoire de drawio-skill contenant scripts/diagramctl.py')
    parser.add_argument('--model', type=Path, default=Path(__file__).with_name('pixelwar.ir.json'))
    parser.add_argument('--output', type=Path, default=Path(__file__).with_name('pixelwar.drawio'))
    args = parser.parse_args()
    model = json.loads(args.model.read_text())
    cli = args.skill_dir.resolve() / 'scripts/diagramctl.py'
    if not cli.is_file():
        parser.error(f'CLI introuvable : {cli}')
    sys.path.insert(0, str(cli.parent))
    import autolayout
    import diagram_ir
    output = ET.Element('mxfile', {'host': 'app.diagrams.net', 'agent': 'drawio-skill',
                                  'type': 'device', 'compressed': 'false'})
    output.set('data-repository', model['metadata']['repository'])
    output.set('data-revision', model['metadata']['revision'])
    temp_root = Path('/tmp/opencode') if Path('/tmp/opencode').is_dir() else None
    with tempfile.TemporaryDirectory(prefix='pixelwar-drawio-', dir=temp_root) as work:
        for view in model['views']:
            ids = set(view['nodes'])
            selected_nodes = [copy.deepcopy(n) for n in model['nodes'] if n['id'] in ids]
            assert len(selected_nodes) == len(ids), view['id']
            selected_edges = [e for e in model['edges'] if view['id'] in e['pages']]
            assert all(e['source'] in ids and e['target'] in ids for e in selected_edges)
            candidate = {**model, 'nodes': selected_nodes, 'edges': selected_edges, 'views': []}
            source = Path(work) / f"{view['id']}.json"
            result = source.with_suffix('.drawio')
            source.write_text(json.dumps(candidate, ensure_ascii=False))
            subprocess.run(['python3', str(cli), 'build', str(source), '--from', 'ir',
                            '--direction', view['direction'], '--title', view['name'],
                            '-o', str(result)], check=True)
            page = ET.parse(result).getroot().find('diagram')
            # Hierarchical placement by semantic stages. Return/read paths must
            # not reverse the main journey. Graphviz still places every node
            # and routes every connector; no large graph is hand-positioned.
            graph_input = diagram_ir.ir_to_graph(candidate)
            graph_input.update(direction=view['direction'], ranksep=2.8, nodesep=0.7)
            for node in graph_input['nodes']:
                node.pop('group', None)
            dot = autolayout.build_dot(graph_input)
            ranks = view.get('ranks', [])
            stages = {node: i for i, rank in enumerate(ranks) for node in rank}
            for edge in selected_edges:
                if stages.get(edge['target'], 999) <= stages.get(edge['source'], -1):
                    source_id = json.dumps(edge['source'])
                    target_id = json.dumps(edge['target'])
                    dot = dot.replace(f'{source_id} -> {target_id};',
                                      f'{source_id} -> {target_id} [constraint=false];')
            rank_lines = ['{rank=same; ' + '; '.join(json.dumps(n) for n in rank) + ';}'
                          for rank in ranks]
            dot = dot.rsplit('}', 1)[0] + '\n' + '\n'.join(rank_lines) + '\n}'
            height, positions, routes = autolayout.layout(dot)
            page = ET.fromstring(autolayout.wrap_page(
                autolayout.page_cells(graph_input, height, positions, routes),
                page_id=view['id'], name=view['name']))
            diagram_ir._annotate_page(page, candidate)
            page.set('id', view['id'])
            page.set('name', view['name'])
            graph = page.find('mxGraphModel')
            graph.set('background', '#ffffff')
            graph.set('page', '0')
            graph.set('pageScale', '1')
            root = graph.find('root')
            # Reserve a header strip; only top-level geometry moves. Children,
            # connectors and model identities keep the native layout output.
            ymax, xmax = 0, 0
            for cell in list(root):
                actual = cell if cell.tag == 'mxCell' else cell.find('mxCell')
                if actual is None:
                    continue
                geo = actual.find('mxGeometry')
                if actual.get('parent') == '1' and geo is not None:
                    if geo.get('y') is not None:
                        geo.set('y', str(float(geo.get('y')) + 130))
                    for point in geo.findall('.//mxPoint'):
                        if point.get('y') is not None:
                            point.set('y', str(float(point.get('y')) + 130))
                    if actual.get('vertex') == '1':
                        xmax = max(xmax, float(geo.get('x', 0)) + float(geo.get('width', 0)))
                        ymax = max(ymax, float(geo.get('y', 0)) + float(geo.get('height', 0)))
            for node in selected_nodes:
                holder = next(c for c in root if c.get('id') == node['id'])
                actual = holder if holder.tag == 'mxCell' else holder.find('mxCell')
                label = '<br>'.join(html.escape(line) for line in node['label'].splitlines())
                if holder.tag == 'mxCell':
                    # Native draw.io links/custom data belong to a UserObject,
                    # not arbitrary mxCell attributes (which the reader drops).
                    wrapper = ET.Element('UserObject', {'id': node['id'], 'label': label})
                    for key in list(actual.attrib):
                        if key.startswith('data-'):
                            wrapper.set(key, actual.attrib.pop(key))
                    actual.attrib.pop('id', None)
                    actual.attrib.pop('value', None)
                    index = list(root).index(holder)
                    root.remove(holder)
                    wrapper.append(actual)
                    root.insert(index, wrapper)
                    holder = wrapper
                else:
                    holder.set('label', label)
                if node['properties']['issues']:
                    # Clickable ticket; provenance remains embedded separately.
                    holder.set('link', node['properties']['issues'][0])
                icon = model['icons'].get(node.get('icon'))
                if icon:
                    scale = 38 / max(icon['w'], icon['h'])
                    w, h = round(icon['w'] * scale, 2), round(icon['h'] * scale, 2)
                    child = ET.SubElement(root, 'mxCell', {
                        'id': node['id'] + '--logo', 'value': '', 'vertex': '1',
                        'parent': node['id'],
                        'style': icon.get('verified_style', icon['style']) + ';pointerEvents=0;movable=0;resizable=0;',
                        'data-logo-title': icon['title'],
                    })
                    ET.SubElement(child, 'mxGeometry', {
                        'x': '0', 'y': '0.5', 'relative': '1',
                        'width': str(w), 'height': str(h), 'as': 'geometry',
                    })
                    ET.SubElement(child.find('mxGeometry'), 'mxPoint', {
                        'x': str(round(12 + (38-w)/2, 2)), 'y': str(round(-h/2, 2)),
                        'as': 'offset',
                    })
            width = max(1400, xmax)
            cell_text(root, 'page-title', html.escape(view['name']), 40, 20, width, 40, 28, True)
            cell_text(root, 'page-subtitle', html.escape(view['subtitle']), 40, 67, width, 30, 16)
            notes = '<br>'.join('• ' + html.escape(n) for n in view['notes'])
            cell_text(root, 'page-notes', notes, 40, ymax+45, width, len(view['notes'])*30+20)
            revision = model['metadata']['revision']
            cell_text(root, 'page-provenance',
                      f'Références : code {revision[:12]} et tickets liés aux composants. '
                      'Couleurs : services bleus, données vertes, événements jaunes, sécurité violette.',
                      40, ymax+len(view['notes'])*30+90, width, 30, 12)
            output.append(page)
    ET.indent(output, space='  ')
    args.output.write_bytes(ET.tostring(output, encoding='utf-8', xml_declaration=True))
    print(args.output)


if __name__ == '__main__':
    main()
