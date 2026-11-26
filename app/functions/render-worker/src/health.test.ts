import type { HttpFunction } from '@google-cloud/functions-framework';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRenderWorkerHandler } from './index';

type Options = Parameters<typeof createRenderWorkerHandler>[0];
function call(method: string) {
  const write = vi.fn(); const log = vi.fn();
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const res = { status: vi.fn(), set: vi.fn(), send: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res); res.set.mockReturnValue(res);
  // No runtime configuration at all: the warmer must still get its answer (ADR-0017).
  const handle = createRenderWorkerHandler({ write, log } as unknown as Options);
  const done = handle({ path: '/health', method, get: () => undefined, body: undefined } as unknown as Parameters<HttpFunction>[0],
    res as unknown as Parameters<HttpFunction>[1]);
  return { done, res, write, log, stdout };
}
afterEach(() => { vi.restoreAllMocks(); });

describe('render-worker warm-up health check', () => {
  it('answers 204 before any configuration check, without log or side effect', async () => {
    const { done, res, write, log, stdout } = call('GET'); await done;
    expect(res.status).toHaveBeenCalledWith(204); expect(res.status).toHaveBeenCalledTimes(1);
    expect(write).not.toHaveBeenCalled(); expect(log).not.toHaveBeenCalled(); expect(stdout).not.toHaveBeenCalled();
  });
  it('refuses another method', async () => {
    const { done, res } = call('POST'); await done;
    expect(res.status).toHaveBeenCalledWith(405);
  });
});
