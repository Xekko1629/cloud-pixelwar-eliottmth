import type { HttpFunction } from '@google-cloud/functions-framework';
import { DrawProcessingError, type DrawCommand } from '@pixelwar/shared/drawing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { discordDrawEvent, drawPush, drawSubscription, processedResult } from '../../../testing/draw-worker-fixtures';
import { testApplication } from '../../../testing/discord-proxy-fixtures';
import { createDrawWorkerHandler, handleDrawWorker } from './index';
import { MAX_PUSH_BYTES } from './message';

function setup(changes: Partial<Parameters<typeof createDrawWorkerHandler>[0]> = {}) {
  const process = vi.fn(async (command) => processedResult(command));
  const publish = vi.fn().mockResolvedValue('confirmed');
  const write = vi.fn();
  const handler = createDrawWorkerHandler({ subscription: drawSubscription, applicationId: testApplication, process, publish, write, ...changes });
  const res = { status: vi.fn(), json: vi.fn(), send: vi.fn(), set: vi.fn() };
  res.status.mockReturnValue(res); res.set.mockReturnValue(res);
  const invoke = async (body: unknown = drawPush(), request = {}) => handler({
    path: '/', method: 'POST', body, rawBody: Buffer.from(JSON.stringify(body)), ...request,
  } as Parameters<HttpFunction>[0], res as unknown as Parameters<HttpFunction>[1]);
  return { invoke, process, publish, write, res };
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('draw-worker handler', () => {
  it('waits for both processing and publication before acknowledging', async () => {
    let release!: (value: ReturnType<typeof processedResult>) => void;
    let publish!: () => void;
    const processing = vi.fn((_command: DrawCommand) => new Promise<ReturnType<typeof processedResult>>((resolve) => { release = resolve; }));
    const publication = vi.fn(() => new Promise<void>((resolve) => { publish = resolve; }));
    const { invoke, res } = setup({ process: processing, publish: publication });
    const pending = invoke();
    expect(res.status).not.toHaveBeenCalled(); expect(publication).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(processing).toHaveBeenCalledTimes(1));
    release(processedResult(processing.mock.calls[0][0]));
    await Promise.resolve();
    expect(publication).toHaveBeenCalledTimes(1); expect(res.status).not.toHaveBeenCalled();
    publish(); await pending;
    expect(res.status).toHaveBeenCalledWith(204); expect(res.send).toHaveBeenCalledWith();
  });
  it('does not log tokens, names, pixels or raw errors', async () => {
    const { invoke, process, write, publish } = setup();
    await invoke(drawPush(discordDrawEvent()));
    expect(JSON.stringify(process.mock.calls)).not.toContain('synthetic-interaction-token');
    expect(publish.mock.calls[0][0].payload.discord.interaction_token).toBe('synthetic-interaction-token');
    expect(JSON.stringify(write.mock.calls)).not.toMatch(/synthetic-interaction-token|Synthetic user|423456789012345678|pixels/);
  });
  it('publishes a business rejection and acknowledges it', async () => {
    const { invoke, process, publish, res } = setup();
    process.mockImplementation(async (command) => ({ ...processedResult(command), type: 'pixel-rejected', reason: 'paused', applied_pixels: 0, ignored_pixels: 0, regions: [] }));
    await invoke();
    expect(publish.mock.calls[0][0]).toMatchObject({ type: 'pixel-rejected', payload: { result: { reason: 'paused' } } });
    expect(res.status).toHaveBeenCalledWith(204);
  });
  it.each([
    [new DrawProcessingError('invalid_command', 'synthetic-interaction-token'), 400],
    [new DrawProcessingError('invalid_state', 'synthetic-interaction-token'), 503],
    [new DrawProcessingError('event_id_conflict', 'synthetic-interaction-token'), 503],
    [new Error('synthetic-interaction-token'), 503],
  ] as const)('does not acknowledge processing error %#', async (error, status) => {
    const { invoke, process, publish, res, write } = setup(); process.mockRejectedValue(error);
    await invoke();
    expect(res.status).toHaveBeenCalledWith(status); expect(publish).not.toHaveBeenCalled(); expect(res.send).not.toHaveBeenCalled();
    expect(JSON.stringify([write.mock.calls, res.json.mock.calls])).not.toContain('synthetic-interaction-token');
  });
  it('returns 503 if publication fails after commit, leaving replay to DATA-02', async () => {
    const { invoke, publish, res, write } = setup();
    publish.mockRejectedValueOnce(new Error('synthetic-interaction-token'));
    await invoke(); expect(res.status).toHaveBeenLastCalledWith(503); expect(res.send).not.toHaveBeenCalled();
    await invoke(); expect(res.status).toHaveBeenLastCalledWith(204);
    expect(publish.mock.calls[0][0]).toEqual(publish.mock.calls[1][0]);
    expect(publish.mock.calls[0][1].correlation_id).toBe(publish.mock.calls[1][1].correlation_id);
    expect(publish.mock.calls[0][1].traceparent.split('-')[1]).toBe(publish.mock.calls[1][1].traceparent.split('-')[1]);
    expect(JSON.stringify(write.mock.calls)).not.toContain('synthetic-interaction-token');
  });
  it('rejects malformed messages without reaching Firestore', async () => {
    const { invoke, process, res, write } = setup();
    await invoke({ subscription: 'bad' });
    expect(process).not.toHaveBeenCalled(); expect(res.status).toHaveBeenCalledWith(400);
    expect(JSON.parse(write.mock.calls[0][0])).toMatchObject({ reason: 'invalid_envelope' });
  });
  it('treats a missing Discord application config as retryable, but permits web traffic', async () => {
    const { invoke, res, process } = setup({ applicationId: undefined });
    await invoke(drawPush(discordDrawEvent())); expect(res.status).toHaveBeenLastCalledWith(503); expect(process).not.toHaveBeenCalled();
    await invoke(); expect(res.status).toHaveBeenLastCalledWith(204);
  });
  it.each([{ subscription: undefined }, { subscription: 'bad' }, { applicationId: 'bad' }, { process: undefined }, { publish: undefined }])('fails closed on invalid config %j', async (changes) => {
    const { invoke, res, process } = setup(changes);
    await invoke(); expect(res.status).toHaveBeenCalledWith(503); expect(process).not.toHaveBeenCalled();
  });
  it('bounds path, method and raw body size', async () => {
    const { invoke, res, process } = setup();
    await invoke(drawPush(), { path: '/other' }); expect(res.status).toHaveBeenLastCalledWith(404);
    await invoke(drawPush(), { method: 'GET' }); expect(res.status).toHaveBeenLastCalledWith(405); expect(res.set).toHaveBeenCalledWith('Allow', 'POST');
    await invoke(drawPush(), { rawBody: Buffer.alloc(MAX_PUSH_BYTES + 1) }); expect(res.status).toHaveBeenLastCalledWith(413);
    await invoke(drawPush(), { rawBody: undefined }); expect(res.status).toHaveBeenLastCalledWith(413);
    expect(process).not.toHaveBeenCalled();
  });
  it('does not expose logging failures or acknowledge prematurely', async () => {
    const { invoke, res } = setup({ write: () => { throw new Error('synthetic-interaction-token'); } });
    await invoke(); expect(res.status).toHaveBeenCalledWith(503);
    expect(res.send).not.toHaveBeenCalled(); expect(JSON.stringify(res.json.mock.calls)).not.toContain('synthetic-interaction-token');
  });
  it('uses a safe default stdout writer', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const { invoke, res } = setup({ write: undefined });
    await invoke(); expect(res.status).toHaveBeenCalledWith(204);
    expect(JSON.parse(String(stdout.mock.calls[0][0])).function).toBe('draw-worker');
  });
  it('exports an unavailable handler without project configuration', async () => {
    const { res } = setup();
    await handleDrawWorker({} as Parameters<HttpFunction>[0], res as unknown as Parameters<HttpFunction>[1]);
    expect(res.status).toHaveBeenCalledWith(503);
  });
  it('initializes its environment entry point lazily without touching Firestore on invalid input', async () => {
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'demo-pixelwar-test'); vi.stubEnv('PIXEL_DRAW_SUBSCRIPTION', drawSubscription);
    vi.stubEnv('DISCORD_APPLICATION_ID', testApplication); vi.resetModules();
    const { handleDrawWorker: entry } = await import('./index');
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const { res } = setup(); const body = {};
    await entry({ path: '/', method: 'POST', body, rawBody: Buffer.from('{}') } as Parameters<HttpFunction>[0], res as unknown as Parameters<HttpFunction>[1]);
    expect(res.status).toHaveBeenCalledWith(400); expect(stdout).toHaveBeenCalled();
  });
});
