import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildFunction, discoverFunctions } from './build';

// npm run build:functions [-- name ...]   →   app/dist/functions/<name>/
// infra/serverless reads that directory: build before terraform plan or apply.

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

export interface Dependencies {
  appDir: string;
  discover: typeof discoverFunctions;
  build: typeof buildFunction;
  print: (message: string) => void;
}

const defaults: Dependencies = { appDir: APP_DIR, discover: discoverFunctions, build: buildFunction, print: console.log };

export async function run(args: string[], deps: Partial<Dependencies> = {}): Promise<string[]> {
  const { appDir, discover, build, print } = { ...defaults, ...deps };
  if (args.some((argument) => argument.startsWith('-'))) throw new Error('Usage: build:functions [function ...]');
  const available = await discover(appDir);
  const unknown = args.filter((name) => !available.includes(name));
  if (unknown.length > 0) throw new Error(`Unknown function(s): ${unknown.join(', ')}. Available: ${available.join(', ') || 'none'}.`);
  const names = args.length > 0 ? [...new Set(args)].sort() : available;

  const outDir = path.join(appDir, 'dist', 'functions');
  for (const name of names) {
    const built = await build(appDir, name, outDir);
    print(`${path.relative(appDir, built.directory).split(path.sep).join('/')} (entry point ${built.entryPoint})`);
  }
  if (names.length === 0) print('No function to build under functions/.');
  return names;
}

export async function main(args: string[], deps: Partial<Dependencies> = {}, report: (message: string) => void = console.error): Promise<number> {
  try {
    await run(args, deps);
    return 0;
  } catch (error) {
    report(`Function build failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
