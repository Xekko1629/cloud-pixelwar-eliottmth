import type { HttpFunction } from '@google-cloud/functions-framework';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { commandFixture, commandPush, commandSubscription, noAdmins } from '../../../testing/command-worker-fixtures';
import { testApplication } from '../../../testing/discord-proxy-fixtures';
import { createCommandWorkerHandler, handleCommandWorker } from './index';
import { MAX_PUSH_BYTES } from './message';

function setup(changes: Partial<Parameters<typeof createCommandWorkerHandler>[0]> = {}) {
  const publish = vi.fn().mockResolvedValue('confirmed');
  const write = vi.fn();
  const handler = createCommandWorkerHandler({ applicationId: testApplication, subscription: commandSubscription, permissions: noAdmins, publish, write, ...changes });
  const res = { status: vi.fn(), json: vi.fn(), send: vi.fn(), set: vi.fn() };
  res.status.mockReturnValue(res); res.set.mockReturnValue(res);
  const invoke = async (body: unknown = commandPush(), request = {}) => handler({
    path: '/', method: 'POST', body, rawBody: Buffer.from(JSON.stringify(body)), ...request,
  } as Parameters<HttpFunction>[0], res as unknown as Parameters<HttpFunction>[1]);
  return { handler, publish, write, res, invoke };
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('command worker acknowledgement', () => {
  it('waits for publication confirmation before returning 204', async () => {
    let resolve!: () => void;
    const publish = vi.fn(() => new Promise<void>((done) => { resolve = done; }));
    const { invoke, res, write } = setup({ publish });
    const pending = invoke();
    await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
    expect(publish).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
    resolve(); await pending;
    expect(res.status).toHaveBeenCalledWith(204);
    expect(res.send).toHaveBeenCalledWith();
    expect(JSON.parse(write.mock.calls[0][0])).toMatchObject({ output_type: 'pixel-draw', message_id: '123' });
    expect(JSON.stringify(write.mock.calls)).not.toMatch(/synthetic-interaction-token|Synthetic user|423456789012345678/);
  });
  it('retries with an identical event after an uncertain publication failure', async () => {
    const { invoke, publish, res, write } = setup();
    publish.mockRejectedValueOnce(new Error('synthetic-interaction-token'));
    await invoke(); expect(res.status).toHaveBeenLastCalledWith(503);
    expect(res.send).not.toHaveBeenCalled();
    const body = commandPush(); body.message.messageId = '456';
    await invoke(body); expect(res.status).toHaveBeenLastCalledWith(204);
    expect(publish.mock.calls[0][0]).toEqual(publish.mock.calls[1][0]);
    expect(publish.mock.calls[0][1].correlation_id).toBe(publish.mock.calls[1][1].correlation_id);
    expect(publish.mock.calls[0][1].traceparent.split('-')[1]).toBe(publish.mock.calls[1][1].traceparent.split('-')[1]);
    expect(JSON.stringify([write.mock.calls, res.json.mock.calls])).not.toContain('synthetic-interaction-token');
  });
  it('routes each concurrent delivery using the same ID without promising a single publication', async () => {
    const { invoke, publish } = setup();
    await Promise.all([invoke(), invoke()]);
    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish.mock.calls[0][0]).toEqual(publish.mock.calls[1][0]);
    expect(publish.mock.calls[0][1].correlation_id).toBe(publish.mock.calls[1][1].correlation_id);
  });
  it('publishes an unauthorized refusal before acknowledging', async () => {
    const { invoke, publish, res, write } = setup();
    await invoke(commandPush(commandFixture('admin', { subcommand: 'clear' })));
    expect(res.status).toHaveBeenCalledWith(204);
    expect(publish.mock.calls[0][0]).toMatchObject({ type: 'command-rejected', payload: { reason: 'unauthorized' } });
    expect(JSON.parse(write.mock.calls[0][0]).severity).toBe('WARNING');
  });
  it('rejects unknown commands with a safe log and no publication', async () => {
    const { invoke, publish, res, write } = setup();
    await invoke(commandPush(commandFixture('synthetic-interaction-token', {})));
    expect(res.status).toHaveBeenCalledWith(400);
    expect(publish).not.toHaveBeenCalled();
    expect(JSON.parse(write.mock.calls[0][0])).toMatchObject({ reason: 'unknown_command' });
    expect(JSON.stringify(write.mock.calls)).not.toContain('synthetic-interaction-token');
  });
  it('does not expose logger failures or acknowledge them', async () => {
    const { invoke, res } = setup({ write: () => { throw new Error('synthetic-interaction-token'); } });
    await invoke(); expect(res.status).toHaveBeenCalledWith(503);
    expect(res.send).not.toHaveBeenCalled();
    expect(JSON.stringify(res.json.mock.calls)).not.toContain('synthetic-interaction-token');
  });
  it('writes only allowlisted fields through the default stdout writer', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const { invoke, res } = setup({ write: undefined });
    await invoke(); expect(res.status).toHaveBeenCalledWith(204);
    expect(stdout).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(stdout.mock.calls[0][0]))).toMatchObject({ function: 'command-worker' });
  });
  it('takes an immutable copy of permissions when constructing the handler', async () => {
    const permissions = { user_ids: ['423456789012345678'], role_ids: [] };
    const { invoke, publish } = setup({ permissions });
    permissions.user_ids.length = 0;
    await invoke(commandPush(commandFixture('admin', { subcommand: 'clear' })));
    expect(publish.mock.calls[0][0].type).toBe('admin-requested');
  });
  it.each([
    { applicationId: undefined }, { applicationId: 'invalid' }, { subscription: undefined },
    { subscription: 'invalid' }, { publish: undefined }, { permissions: undefined },
    { permissions: { user_ids: ['invalid'], role_ids: [] } },
  ])('fails closed on missing or invalid configuration %j', async (changes) => {
    const { invoke, res, publish } = setup(changes);
    await invoke(); expect(res.status).toHaveBeenCalledWith(503);
    expect(publish).not.toHaveBeenCalled();
  });
  it('enforces the path, method and raw body size limits', async () => {
    const { invoke, res, publish } = setup();
    await invoke(commandPush(), { path: '/other' }); expect(res.status).toHaveBeenLastCalledWith(404);
    await invoke(commandPush(), { method: 'GET' }); expect(res.status).toHaveBeenLastCalledWith(405);
    expect(res.set).toHaveBeenCalledWith('Allow', 'POST');
    await invoke(commandPush(), { rawBody: Buffer.alloc(MAX_PUSH_BYTES + 1) }); expect(res.status).toHaveBeenLastCalledWith(413);
    await invoke(commandPush(), { rawBody: undefined }); expect(res.status).toHaveBeenLastCalledWith(413);
    expect(publish).not.toHaveBeenCalled();
  });
  it('exports an entry point that is unavailable without configuration', async () => {
    const { res } = setup();
    await handleCommandWorker({} as Parameters<HttpFunction>[0], res as unknown as Parameters<HttpFunction>[1]);
    expect(res.status).toHaveBeenCalledWith(503);
  });
  it.each([undefined, 'bad-json', 'null', '[]', '{}', '{"user_ids":["invalid"],"role_ids":[]}', '{"user_ids":[],"role_ids":[],"extra":1}'])('rejects invalid secret allowlist configuration without leaking it: %s', async (value) => {
    vi.stubEnv('DISCORD_ADMIN_ALLOWLIST', value);
    vi.stubEnv('DISCORD_APPLICATION_ID', testApplication);
    vi.stubEnv('DISCORD_COMMAND_SUBSCRIPTION', commandSubscription);
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'demo-pixelwar-test');
    vi.resetModules();
    const { handleCommandWorker: entry } = await import('./index');
    const { res } = setup();
    await entry({} as Parameters<HttpFunction>[0], res as unknown as Parameters<HttpFunction>[1]);
    expect(res.status).toHaveBeenCalledWith(503);
  });
  it('accepts an explicitly empty allowlist but does not acknowledge a missing output topic', async () => {
    vi.stubEnv('DISCORD_ADMIN_ALLOWLIST', '{"user_ids":[],"role_ids":[]}');
    vi.stubEnv('DISCORD_APPLICATION_ID', testApplication);
    vi.stubEnv('DISCORD_COMMAND_SUBSCRIPTION', commandSubscription);
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'demo-pixelwar-test');
    vi.stubEnv('PIXEL_DRAW_TOPIC', undefined);
    vi.resetModules();
    const { handleCommandWorker: entry } = await import('./index');
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const { res } = setup(); const body = commandPush();
    await entry({ path: '/', method: 'POST', body, rawBody: Buffer.from(JSON.stringify(body)) } as Parameters<HttpFunction>[0],
      res as unknown as Parameters<HttpFunction>[1]);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(stdout).toHaveBeenCalled();
  });
});
