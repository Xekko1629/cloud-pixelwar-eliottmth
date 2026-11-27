import { open, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { logFilter, summarize, type LogEntry } from './report';
import { sendStrokes, validateSettings, type RunRecord } from './send';

const USAGE = [
  'Usage:',
  '  loadtest send --strokes N --pixels P --x X --y Y --out RUN.json',
  '  loadtest report --run RUN.json --logs LOGS.json',
].join('\n');

function options(args: string[], allowed: string[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]?.startsWith('--') ? args[index].slice(2) : '';
    if (!allowed.includes(name) || name in values || args[index + 1] === undefined) throw new Error(USAGE);
    values[name] = args[index + 1];
  }
  for (const name of allowed) if (!(name in values)) throw new Error(USAGE);
  return values;
}
const integer = (value: string) => (/^-?\d+$/.test(value) ? Number(value) : Number.NaN);

export async function run(
  args: string[], env: NodeJS.ProcessEnv, print: (message: string) => void = console.log,
  send: typeof sendStrokes = sendStrokes,
): Promise<void> {
  const [command, ...rest] = args;
  if (command === 'send') {
    const values = options(rest, ['strokes', 'pixels', 'x', 'y', 'out']);
    const settings = {
      baseUrl: env.PIXELWAR_GATEWAY_URL ?? '', token: env.PIXELWAR_SESSION_TOKEN ?? '',
      strokes: integer(values.strokes), pixels: integer(values.pixels), x: integer(values.x), y: integer(values.y),
    };
    validateSettings(settings);
    // Created before sending: an existing file must not lose the record of a run already sent.
    const file = await open(values.out, 'wx').catch(() => { throw new Error('--out must be a new file.'); });
    let record: RunRecord;
    try {
      record = await send(settings);
      await file.writeFile(`${JSON.stringify(record, null, 2)}\n`);
    } finally { await file.close(); }
    const accepted = record.results.filter((s) => s.status === 202).length;
    print(`${accepted}/${record.strokes} strokes accepted, ${record.results.reduce((n, s) => n + s.event_ids.length, 0)} pixels published.`);
    print('Wait until the subscription backlog is empty, then export the draw-worker logs:');
    print(`gcloud logging read '${logFilter(record)}' --project=<dev project> --freshness=1h --limit=20000 --format=json > LOGS.json`);
    return;
  }
  if (command === 'report') {
    const values = options(rest, ['run', 'logs']);
    const record = JSON.parse(await readFile(values.run, 'utf8')) as RunRecord;
    if (record.schema_version !== 1 || !Array.isArray(record.results)) throw new Error('Not a loadtest run file.');
    const entries = JSON.parse(await readFile(values.logs, 'utf8')) as LogEntry[];
    if (!Array.isArray(entries)) throw new Error('The logs file must be the JSON array of gcloud logging read.');
    print(JSON.stringify(summarize(record, entries), null, 2));
    return;
  }
  throw new Error(USAGE);
}

export async function main(
  args: string[], env: NodeJS.ProcessEnv,
  print: (message: string) => void = console.log, report: (message: string) => void = console.error,
): Promise<number> {
  try {
    await run(args, env, print);
    return 0;
  } catch (error) {
    // Our own messages never contain the token; any other error is replaced by a fixed text.
    const known = error instanceof Error && (error.message === USAGE || /^(--|PIXELWAR_|Not a|The logs)/.test(error.message));
    report(known ? (error as Error).message : 'Load test failed; no credentials were logged.');
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2), process.env);
}
