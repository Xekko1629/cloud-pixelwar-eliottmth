import { appendFileSync, existsSync, readFileSync } from 'node:fs';

const file = 'coverage/coverage-summary.json';
if (process.env.GITHUB_STEP_SUMMARY && existsSync(file)) {
  const coverage = JSON.parse(readFileSync(file, 'utf8'));
  const lines = [
    '## Application — couverture unitaire',
    '',
    'Seuil obligatoire : 70 % par fichier pour lignes, instructions, fonctions et branches.',
    'Les sources sans test sont incluses. Les tests d’intégration sont exécutés séparément.',
    '',
    '| Périmètre | Lignes | Instructions | Fonctions | Branches |',
    '| --- | --- | --- | --- | --- |',
  ];
  for (const [name, metrics] of Object.entries(coverage)) {
    const label = name === 'total' ? '**Total**' : name.replace(`${process.cwd()}/`, '');
    lines.push(`| ${label} | ${metrics.lines.pct}% | ${metrics.statements.pct}% | ${metrics.functions.pct}% | ${metrics.branches.pct}% |`);
  }
  lines.push('', 'Le rapport HTML et les résultats JUnit sont disponibles dans les artefacts du run.', '');
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n'));
}
