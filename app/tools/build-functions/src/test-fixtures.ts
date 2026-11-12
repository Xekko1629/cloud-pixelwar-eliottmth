import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Throw-away npm workspace shaped like app/: shared, one function, and a lockfile where
// shared installs its own version of a package (shared/node_modules), as in the real lock.

export function fixtureLock() {
  return {
    lockfileVersion: 3,
    packages: {
      '': { name: 'fixture' },
      'node_modules/@pixelwar/shared': { resolved: 'shared', link: true },
      'node_modules/@google-cloud/functions-framework': { version: '5.0.5' },
      'node_modules/lib-fn': { version: '2.0.0' },
      // Root version used by dev tooling only; shared has its own.
      'node_modules/lib-shared': { version: '0.9.0', dev: true },
      'shared/node_modules/lib-shared': { version: '1.0.0' },
    },
  };
}

export interface FixtureApp {
  appDir: string;
  write: (file: string, content: string) => Promise<void>;
  cleanup: () => Promise<void>;
}

export async function createFixtureApp(): Promise<FixtureApp> {
  const appDir = await mkdtemp(path.join(tmpdir(), 'pixelwar-build-'));
  const write = async (file: string, content: string) => {
    const target = path.join(appDir, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  };
  await write('package.json', JSON.stringify({ name: 'fixture', private: true, workspaces: ['shared', 'functions/*'] }));
  await write('package-lock.json', JSON.stringify(fixtureLock()));
  await write('shared/package.json', JSON.stringify({
    name: '@pixelwar/shared',
    type: 'module',
    exports: { './util': './src/util.ts' },
    dependencies: { 'lib-shared': '1.0.0' },
  }));
  await write('shared/src/util.ts', [
    "import { join } from 'node:path';",
    "import { value } from 'lib-shared';",
    "export const util = (): string => join('a', String(value));",
  ].join('\n'));
  await write('functions/hello-fn/package.json', JSON.stringify({
    name: '@pixelwar/function-hello-fn',
    type: 'module',
    pixelwar: { entryPoint: 'hello' },
    dependencies: { '@google-cloud/functions-framework': '5.0.5', '@pixelwar/shared': '*', 'lib-fn': '2.0.0' },
  }));
  await write('functions/hello-fn/src/index.ts', [
    "import { util } from '@pixelwar/shared/util';",
    "import { other } from 'lib-fn/sub';",
    'export function hello(_req: unknown, res: { send: (body: string) => void }): void {',
    '  res.send(util() + other);',
    '}',
  ].join('\n'));
  await mkdir(path.join(appDir, 'node_modules', '@pixelwar'), { recursive: true });
  // A junction needs no privilege on Windows; it is a plain directory symlink elsewhere.
  await symlink(path.join(appDir, 'shared'), path.join(appDir, 'node_modules', '@pixelwar', 'shared'), 'junction');
  return { appDir, write, cleanup: () => rm(appDir, { recursive: true, force: true }) };
}
