import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bundleFunction, isBuiltin, packageNameOf, workspaceOf } from './bundle';
import { createFixtureApp, type FixtureApp } from './test-fixtures';

describe('import specifiers', () => {
  it.each([
    ['lib', 'lib'],
    ['lib/sub/path', 'lib'],
    ['@scope/lib', '@scope/lib'],
    ['@scope/lib/sub', '@scope/lib'],
  ])('%s belongs to package %s', (specifier, name) => {
    expect(packageNameOf(specifier)).toBe(name);
  });

  it.each([['node:crypto', true], ['crypto', true], ['fs/promises', true], ['lib', false], ['@google-cloud/pubsub', false]])(
    '%s is a builtin: %s', (specifier, builtin) => {
      expect(isBuiltin(specifier)).toBe(builtin);
    },
  );

  it('only bundles the function and shared', () => {
    const appDir = path.resolve('/app');
    expect(workspaceOf(appDir, 'functions/fn', path.join(appDir, 'functions', 'fn', 'src'))).toBe('functions/fn');
    expect(workspaceOf(appDir, 'functions/fn', path.join(appDir, 'shared', 'src', 'grid'))).toBe('shared');
    expect(() => workspaceOf(appDir, 'functions/fn', path.join(appDir, 'functions', 'fn-other', 'src'))).toThrow('functions/fn-other/src');
    expect(() => workspaceOf(appDir, 'functions/fn', path.join(appDir, 'frontend'))).toThrow('cannot be bundled');
    expect(() => workspaceOf(appDir, 'functions/fn', appDir)).toThrow('. is outside');
  });
});

describe('function bundle', () => {
  let fixture: FixtureApp;
  beforeEach(async () => {
    fixture = await createFixtureApp();
  });
  afterEach(async () => {
    await fixture.cleanup();
  });

  it('inlines first-party code and keeps npm packages external, per importing workspace', async () => {
    const bundle = await bundleFunction(fixture.appDir, 'functions/hello-fn');
    const code = bundle.code.toString('utf8');
    expect(code).toContain('// shared/src/util.ts');
    expect(code).toContain('from "lib-shared"');
    expect(code).toContain('from "lib-fn/sub"');
    expect(code).not.toContain('@pixelwar/shared');
    expect(bundle.exports).toEqual(['hello']);
    expect(bundle.externals).toEqual([
      { workspace: 'functions/hello-fn', name: 'lib-fn' },
      { workspace: 'shared', name: 'lib-shared' },
    ]);
    expect(bundle.inputs).toEqual(['functions/hello-fn/src/index.ts', 'shared/src/util.ts']);
  });

  it('is byte-for-byte reproducible', async () => {
    const first = await bundleFunction(fixture.appDir, 'functions/hello-fn');
    const second = await bundleFunction(fixture.appDir, 'functions/hello-fn');
    expect(second.code.equals(first.code)).toBe(true);
  });

  it('refuses first-party code outside the function and shared', async () => {
    await fixture.write('frontend/src/ui.ts', 'export const ui = 1;');
    await fixture.write('functions/hello-fn/src/index.ts', "import { ui } from '../../../frontend/src/ui';\nexport const hello = () => ui;");
    await expect(bundleFunction(fixture.appDir, 'functions/hello-fn')).rejects.toThrow('frontend/src');
  });

  it('refuses an npm import from code that cannot be bundled', async () => {
    await fixture.write('frontend/src/ui.ts', "export { x } from 'lib-front';");
    await fixture.write('functions/hello-fn/src/index.ts', "export { x as hello } from '../../../frontend/src/ui';");
    await expect(bundleFunction(fixture.appDir, 'functions/hello-fn')).rejects.toThrow('cannot be bundled');
  });

  it('refuses a test file reachable from the handler', async () => {
    await fixture.write('functions/hello-fn/src/helper.test.ts', 'export const fake = 1;');
    await fixture.write('functions/hello-fn/src/index.ts', "import { fake } from './helper.test';\nexport const hello = () => fake;");
    await expect(bundleFunction(fixture.appDir, 'functions/hello-fn')).rejects.toThrow('test file');
  });
});
