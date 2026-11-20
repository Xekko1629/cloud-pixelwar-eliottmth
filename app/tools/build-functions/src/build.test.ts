import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildFunction, discoverFunctions, lockedVersion } from './build';
import { createFixtureApp, fixtureLock, type FixtureApp } from './test-fixtures';

describe('function build', () => {
  let fixture: FixtureApp;
  let outDir: string;
  beforeEach(async () => {
    fixture = await createFixtureApp();
    outDir = path.join(fixture.appDir, 'dist', 'functions');
  });
  afterEach(async () => {
    await fixture.cleanup();
  });

  it('discovers function directories that have a package.json', async () => {
    await fixture.write('functions/draft/notes.md', 'not a function');
    await fixture.write('functions/.gitkeep', '');
    await fixture.write('functions/auth-proxy/package.json', '{}');
    expect(await discoverFunctions(fixture.appDir)).toEqual(['auth-proxy', 'hello-fn']);
  });

  it('writes only the bundle and a package.json with the locked versions', async () => {
    await fixture.write('functions/hello-fn/.env', 'SECRET=never-copied');
    await fixture.write('functions/hello-fn/src/index.test.ts', 'test file');
    await fixture.write('dist/functions/hello-fn/stale.js', 'from a previous build');

    const built = await buildFunction(fixture.appDir, 'hello-fn', outDir);
    expect(built.entryPoint).toBe('hello');
    expect(built.directory).toBe(path.join(outDir, 'hello-fn'));
    expect((await readdir(built.directory)).sort()).toEqual(['index.js', 'package.json']);

    const packageJson = JSON.parse(await readFile(path.join(built.directory, 'package.json'), 'utf8'));
    expect(packageJson).toEqual({
      name: 'pixelwar-function-hello-fn',
      version: '1.0.0',
      private: true,
      type: 'module',
      main: 'index.js',
      // shared gets its own lib-shared (1.0.0), not the root dev copy (0.9.0).
      dependencies: { '@google-cloud/functions-framework': '5.0.5', 'lib-fn': '2.0.0', 'lib-shared': '1.0.0' },
    });
    const code = await readFile(path.join(built.directory, 'index.js'), 'utf8');
    expect(code).toContain('// shared/src/util.ts');
    expect(code).not.toContain('SECRET');
  });

  it('gives the same files for the same sources', async () => {
    await buildFunction(fixture.appDir, 'hello-fn', outDir);
    const first = await readFile(path.join(outDir, 'hello-fn', 'index.js'));
    await buildFunction(fixture.appDir, 'hello-fn', outDir);
    expect((await readFile(path.join(outDir, 'hello-fn', 'index.js'))).equals(first)).toBe(true);
  });

  it.each(['Hello', 'fn', 'trailing-', `x${'a'.repeat(30)}`])('refuses the function name %j', async (name) => {
    await expect(buildFunction(fixture.appDir, name, outDir)).rejects.toThrow('6 to 30');
  });

  it('requires a valid exported entry point', async () => {
    const manifest = (pixelwar: unknown) => JSON.stringify({
      pixelwar,
      dependencies: { '@google-cloud/functions-framework': '5.0.5', 'lib-fn': '2.0.0' },
    });
    await fixture.write('functions/hello-fn/package.json', manifest(undefined));
    await expect(buildFunction(fixture.appDir, 'hello-fn', outDir)).rejects.toThrow('pixelwar.entryPoint');
    await fixture.write('functions/hello-fn/package.json', manifest({ entryPoint: 'not-an-identifier' }));
    await expect(buildFunction(fixture.appDir, 'hello-fn', outDir)).rejects.toThrow('pixelwar.entryPoint');
    await fixture.write('functions/hello-fn/package.json', manifest({ entryPoint: 'missing' }));
    await expect(buildFunction(fixture.appDir, 'hello-fn', outDir)).rejects.toThrow('does not export missing');
  });

  it('requires runtime dependencies, including the Functions Framework, to be declared', async () => {
    const declare = (dependencies: Record<string, string>) => fixture.write('functions/hello-fn/package.json', JSON.stringify({ pixelwar: { entryPoint: 'hello' }, dependencies }));
    await declare({ 'lib-fn': '2.0.0' });
    await expect(buildFunction(fixture.appDir, 'hello-fn', outDir)).rejects.toThrow('@google-cloud/functions-framework is used by functions/hello-fn');
    await declare({ '@google-cloud/functions-framework': '5.0.5' });
    await expect(buildFunction(fixture.appDir, 'hello-fn', outDir)).rejects.toThrow('lib-fn is used by functions/hello-fn');

    await fixture.write('shared/package.json', JSON.stringify({ name: '@pixelwar/shared', exports: { './util': './src/util.ts' } }));
    await declare({ '@google-cloud/functions-framework': '5.0.5', 'lib-fn': '2.0.0' });
    await expect(buildFunction(fixture.appDir, 'hello-fn', outDir)).rejects.toThrow('lib-shared is used by shared');
  });

  it('refuses a package needed at two versions by the same function', async () => {
    await fixture.write('functions/hello-fn/src/index.ts', [
      "import { util } from '@pixelwar/shared/util';",
      "import { value } from 'lib-shared';",
      'export const hello = () => util() + value;',
    ].join('\n'));
    await fixture.write('functions/hello-fn/package.json', JSON.stringify({
      pixelwar: { entryPoint: 'hello' },
      dependencies: { '@google-cloud/functions-framework': '5.0.5', 'lib-shared': '0.9.0' },
    }));
    await expect(buildFunction(fixture.appDir, 'hello-fn', outDir)).rejects.toThrow('locked at');
  });
});

describe('locked versions', () => {
  const lock = fixtureLock();
  it.each([
    ['shared', 'lib-shared', '1.0.0'],
    ['functions/hello-fn', 'lib-shared', '0.9.0'],
    ['shared', 'lib-fn', '2.0.0'],
  ])('%s gets %s %s', (workspace, name, version) => {
    expect(lockedVersion(lock, workspace, name)).toBe(version);
  });
  it('refuses a package that is not installed', () => {
    expect(() => lockedVersion(lock, 'shared', 'unknown')).toThrow('npm install');
  });
});
