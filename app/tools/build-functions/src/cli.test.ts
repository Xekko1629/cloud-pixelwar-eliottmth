import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { main, run } from './cli';

const appDir = path.resolve('/app');

function fakes(available = ['hello-fn', 'auth-proxy']) {
  return {
    appDir,
    discover: vi.fn().mockResolvedValue(available),
    build: vi.fn(async (_appDir: string, name: string, outDir: string) => ({
      name, entryPoint: 'handler', directory: path.join(outDir, name), dependencies: {},
    })),
    print: vi.fn(),
  };
}

describe('build command', () => {
  it('builds every function into dist/functions by default', async () => {
    const deps = fakes();
    expect(await run([], deps)).toEqual(['hello-fn', 'auth-proxy']);
    expect(deps.build).toHaveBeenCalledWith(appDir, 'hello-fn', path.join(appDir, 'dist', 'functions'));
    expect(deps.print).toHaveBeenCalledWith('dist/functions/hello-fn (entry point handler)');
  });

  it('builds only the selected functions, once each', async () => {
    const deps = fakes();
    expect(await run(['hello-fn', 'hello-fn'], deps)).toEqual(['hello-fn']);
    expect(deps.build).toHaveBeenCalledTimes(1);
  });

  it('refuses options and unknown functions, and reports when there is nothing to build', async () => {
    await expect(run(['--out'], fakes())).rejects.toThrow('Usage');
    await expect(run(['nope-fn'], fakes())).rejects.toThrow('Unknown function(s): nope-fn. Available: hello-fn, auth-proxy.');
    await expect(run(['nope-fn'], fakes([]))).rejects.toThrow('Available: none.');
    const deps = fakes([]);
    expect(await run([], deps)).toEqual([]);
    expect(deps.print).toHaveBeenCalledWith('No function to build under functions/.');
  });

  it('returns an exit code and a single error line', async () => {
    const report = vi.fn();
    expect(await main([], fakes())).toBe(0);
    expect(await main(['--bad'], fakes(), report)).toBe(1);
    expect(report.mock.calls[0][0]).toMatch(/^Function build failed: Usage/);
    expect(await main([], { ...fakes(), build: vi.fn().mockRejectedValue('boom') }, report)).toBe(1);
    expect(report.mock.calls[1][0]).toBe('Function build failed: boom');
  });
});
