import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { bundleFunction } from './bundle';

// Builds the source directory of each Cloud Run function (ADR-0009):
//   app/dist/functions/<name>/index.js      the function and @pixelwar/shared, bundled
//   app/dist/functions/<name>/package.json  the npm packages it imports, at their locked versions
// Terraform zips that directory (archive_file) and uploads it; Google installs the
// dependencies and builds the image. Nothing else is copied: no .env, test or local file.
//
// A function is app/functions/<name> with:
//   package.json  { "pixelwar": { "entryPoint": "<exported handler>" }, "dependencies": { ... } }
//   src/index.ts  exports the HTTP handler (req, res), Functions Framework signature.

export const FUNCTIONS_FRAMEWORK = '@google-cloud/functions-framework';
// Same rule as the name of module function (infra/serverless/modules/function).
const FUNCTION_NAME = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const ENTRY_POINT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

interface WorkspaceManifest {
  dependencies?: Record<string, string>;
  pixelwar?: { entryPoint?: unknown };
}

export interface Lockfile {
  packages: Record<string, { version?: string; [field: string]: unknown }>;
}

export interface BuiltFunction {
  name: string;
  entryPoint: string;
  directory: string;
  dependencies: Record<string, string>;
}

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, 'utf8')) as T;
}

export async function discoverFunctions(appDir: string): Promise<string[]> {
  const entries = await readdir(path.join(appDir, 'functions'), { withFileTypes: true });
  const names: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const files = await readdir(path.join(appDir, 'functions', entry.name));
    if (files.includes('package.json')) names.push(entry.name);
  }
  return names.sort();
}

// Version installed for a workspace: its own node_modules first, then the root (npm workspaces).
export function lockedVersion(lock: Lockfile, workspace: string, name: string): string {
  const version = (lock.packages[`${workspace}/node_modules/${name}`] ?? lock.packages[`node_modules/${name}`])?.version;
  if (!version) throw new Error(`${name}, used by ${workspace}, is not in package-lock.json: run npm install.`);
  return version;
}

export async function buildFunction(appDir: string, name: string, outDir: string): Promise<BuiltFunction> {
  if (!FUNCTION_NAME.test(name)) {
    throw new Error(`Function directory ${name} must be 6 to 30 lowercase letters, digits or hyphens (module function name).`);
  }
  const workspace = `functions/${name}`;
  const manifests: Record<string, WorkspaceManifest> = {
    [workspace]: await readJson<WorkspaceManifest>(path.join(appDir, workspace, 'package.json')),
    shared: await readJson<WorkspaceManifest>(path.join(appDir, 'shared', 'package.json')),
  };
  const entryPoint = manifests[workspace].pixelwar?.entryPoint;
  if (typeof entryPoint !== 'string' || !ENTRY_POINT.test(entryPoint)) {
    throw new Error(`${workspace}/package.json must set pixelwar.entryPoint to the exported handler name.`);
  }

  const bundle = await bundleFunction(appDir, workspace);
  if (!bundle.exports.includes(entryPoint)) throw new Error(`${workspace}/src/index.ts does not export ${entryPoint}.`);

  // Runtime dependencies must be declared by the workspace that imports them (never a hoisted
  // devDependency), and the Functions Framework is pinned rather than chosen by Cloud Build.
  const lock = await readJson<Lockfile>(path.join(appDir, 'package-lock.json'));
  const dependencies: Record<string, string> = {};
  for (const request of [...bundle.externals, { workspace, name: FUNCTIONS_FRAMEWORK }]) {
    if (!manifests[request.workspace].dependencies?.[request.name]) {
      throw new Error(`${request.name} is used by ${request.workspace} but missing from its package.json dependencies.`);
    }
    const version = lockedVersion(lock, request.workspace, request.name);
    if (dependencies[request.name] && dependencies[request.name] !== version) {
      throw new Error(`${request.name} is locked at ${dependencies[request.name]} and ${version} for this function: align the versions.`);
    }
    dependencies[request.name] = version;
  }
  const sorted = Object.fromEntries(Object.keys(dependencies).sort().map((key) => [key, dependencies[key]]));

  const directory = path.join(outDir, name);
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'index.js'), bundle.code);
  const packageJson = { name: `pixelwar-function-${name}`, version: '1.0.0', private: true, type: 'module', main: 'index.js', dependencies: sorted };
  await writeFile(path.join(directory, 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`);
  return { name, entryPoint, directory, dependencies: sorted };
}
