import { build, type Plugin } from 'esbuild';
import { builtinModules } from 'node:module';
import path from 'node:path';

// Bundles the first-party code of one function (its sources and @pixelwar/shared) into a
// single ESM file: shared is an npm workspace, not a published package, so Cloud Build could
// not install it. npm packages stay external and are installed by Cloud Build, so their
// native files, JSON and protos keep working as published.

// An npm package imported by first-party code, with the workspace that imports it
// (functions/<name> or shared).
export interface DependencyRequest {
  workspace: string;
  name: string;
}

export interface FunctionBundle {
  code: Buffer;
  exports: string[];
  externals: DependencyRequest[];
  inputs: string[];
}

const BUILTINS = new Set(builtinModules);
const FIRST_PARTY_SCOPE = '@pixelwar/';

export function packageNameOf(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

export function isBuiltin(specifier: string): boolean {
  return specifier.startsWith('node:') || BUILTINS.has(packageNameOf(specifier));
}

function toPosix(relative: string): string {
  return relative.split(path.sep).join('/');
}

// Workspace (relative to the app directory) that owns a file: only the function itself and
// shared may be bundled; any other first-party code is refused.
export function workspaceOf(appDir: string, functionWorkspace: string, directory: string): string {
  const relative = toPosix(path.relative(appDir, directory));
  for (const workspace of [functionWorkspace, 'shared']) {
    if (relative === workspace || relative.startsWith(`${workspace}/`)) return workspace;
  }
  throw new Error(`${relative || '.'} is outside ${functionWorkspace} and shared: it cannot be bundled into the function.`);
}

export async function bundleFunction(appDir: string, functionWorkspace: string): Promise<FunctionBundle> {
  const externals = new Map<string, DependencyRequest>();
  const externalize: Plugin = {
    name: 'externalize-npm-packages',
    setup(context) {
      context.onResolve({ filter: /^[^./]/ }, (args) => {
        if (args.kind === 'entry-point' || path.isAbsolute(args.path) || args.path.startsWith(FIRST_PARTY_SCOPE)) return undefined;
        if (isBuiltin(args.path)) return { path: args.path, external: true };
        const request = { workspace: workspaceOf(appDir, functionWorkspace, args.resolveDir), name: packageNameOf(args.path) };
        externals.set(`${request.workspace} ${request.name}`, request);
        return { path: args.path, external: true };
      });
    },
  };

  const result = await build({
    absWorkingDir: appDir,
    entryPoints: [`${functionWorkspace}/src/index.ts`],
    outfile: 'index.js',
    bundle: true,
    write: false,
    metafile: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    // Readable stack traces in Cloud Logging without shipping source maps.
    minify: false,
    sourcemap: false,
    legalComments: 'none',
    charset: 'utf8',
    logLevel: 'silent',
    plugins: [externalize],
  });

  const [output] = result.outputFiles;
  const meta = Object.values(result.metafile.outputs)[0];
  const inputs = Object.keys(result.metafile.inputs).map(toPosix).sort();
  for (const input of inputs) {
    workspaceOf(appDir, functionWorkspace, path.join(appDir, path.dirname(input)));
    if (/\.test\.[cm]?[jt]s$/.test(input)) throw new Error(`A test file is reachable from the handler: ${input}`);
  }
  return {
    code: Buffer.from(output.contents),
    exports: [...meta.exports].sort(),
    externals: [...externals.values()].sort((a, b) => (`${a.name} ${a.workspace}` < `${b.name} ${b.workspace}` ? -1 : 1)),
    inputs,
  };
}
