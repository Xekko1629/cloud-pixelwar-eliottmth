import type { HttpFunction } from '@google-cloud/functions-framework';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { notificationEvent, notifierPush, notifierSubscriptions } from '../../../testing/discord-notifier-fixtures';
import { testApplication } from '../../../testing/discord-proxy-fixtures';
import { createDiscordNotifierHandler, handleDiscordNotifier } from './index';
import { NotificationFailure } from './discord';
import { MAX_PUSH_BYTES } from './message';

function setup(changes: Partial<Parameters<typeof createDiscordNotifierHandler>[0]> = {}) {
  const update = vi.fn().mockResolvedValue('updated');
  const write = vi.fn();
  const handler = createDiscordNotifierHandler({ applicationId: testApplication, subscriptions: notifierSubscriptions, update, write, ...changes });
  const res = { status: vi.fn(), json: vi.fn(), send: vi.fn(), set: vi.fn() };
  res.status.mockReturnValue(res); res.set.mockReturnValue(res);
  const invoke = async (body: unknown = notifierPush(), request = {}) => handler({ path: '/', method: 'POST', body,
    rawBody: Buffer.from(JSON.stringify(body)), ...request } as Parameters<HttpFunction>[0], res as unknown as Parameters<HttpFunction>[1]);
  return { invoke, update, write, res };
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('notifier acknowledgement', () => {
  it('waits for the PATCH to finish before acknowledging', async () => {
    let release!: (outcome: 'updated') => void;
    const update = vi.fn<import('./discord').UpdateOriginal>(() => new Promise((resolve) => { release = resolve; }));
    const { invoke, res, write } = setup({ update });
    const pending = invoke(); expect(res.status).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    release('updated'); await pending;
    expect(res.status).toHaveBeenCalledWith(204); expect(res.send).toHaveBeenCalledWith();
    expect(JSON.parse(write.mock.calls[0][0])).toMatchObject({ event_type: 'discord.notification.updated', message_id: '123' });
    expect(JSON.stringify(write.mock.calls)).not.toMatch(/synthetic-interaction-token|Synthetic user|423456789012345678|webhooks/);
  });
  it('acknowledges expired notifications with a warning rather than a retry', async () => {
    const { invoke, update, write, res } = setup(); update.mockResolvedValue('expired');
    await invoke();
    expect(res.status).toHaveBeenCalledWith(204);
    expect(JSON.parse(write.mock.calls[0][0])).toMatchObject({ severity: 'WARNING', event_type: 'discord.notification.expired' });
  });
  it('skips valid web results without any Discord call', async () => {
    const { invoke, update, res, write } = setup();
    await invoke(notifierPush(notificationEvent('pixel-processed', 'web')));
    expect(update).not.toHaveBeenCalled(); expect(res.status).toHaveBeenCalledWith(204);
    expect(JSON.parse(write.mock.calls[0][0]).event_type).toBe('discord.notification.skipped_web');
  });
  it('makes concurrent duplicate deliveries use the same update content', async () => {
    const { invoke, update } = setup();
    const duplicate = notifierPush(); duplicate.message.messageId = '456';
    await Promise.all([invoke(), invoke(duplicate)]);
    expect(update).toHaveBeenCalledTimes(2);
    expect(update.mock.calls[0][0].result).toEqual(update.mock.calls[1][0].result);
    expect(update.mock.calls[0][0].discord).toEqual(update.mock.calls[1][0].discord);
  });
  it.each([
    new Error('https://discord.com/webhooks/synthetic-interaction-token'),
    new NotificationFailure('network'), new NotificationFailure('http', 503),
  ])('does not leak SDK/HTTP failures and leaves the source retryable %#', async (error) => {
    const { invoke, update, write, res } = setup(); update.mockRejectedValue(error);
    await invoke();
    expect(res.status).toHaveBeenCalledWith(503); expect(res.send).not.toHaveBeenCalled();
    expect(JSON.stringify([write.mock.calls, res.json.mock.calls])).not.toMatch(/synthetic-interaction-token|webhooks/);
  });
  it('returns a sanitized Retry-After hint on rate limits', async () => {
    const { invoke, update, res } = setup(); update.mockRejectedValue(new NotificationFailure('rate_limited', 429, 3));
    await invoke(); expect(res.status).toHaveBeenCalledWith(503); expect(res.set).toHaveBeenCalledWith('Retry-After', '3');
  });
  it('rejects malformed results without making an outbound request', async () => {
    const { invoke, update, write, res } = setup();
    await invoke({ subscription: 'wrong' });
    expect(res.status).toHaveBeenCalledWith(400); expect(update).not.toHaveBeenCalled();
    expect(JSON.parse(write.mock.calls[0][0])).toMatchObject({ reason: 'invalid_envelope' });
  });
  it('does not acknowledge a failed log write or leak its error', async () => {
    const { invoke, res } = setup({ write: () => { throw new Error('synthetic-interaction-token'); } });
    await invoke(); expect(res.status).toHaveBeenCalledWith(503); expect(res.send).not.toHaveBeenCalled();
    expect(JSON.stringify(res.json.mock.calls)).not.toContain('synthetic-interaction-token');
  });
  it('writes a safe structured stdout log by default', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const { invoke, res } = setup({ write: undefined });
    await invoke(); expect(res.status).toHaveBeenCalledWith(204);
    expect(JSON.parse(String(stdout.mock.calls[0][0])).function).toBe('discord-notifier');
  });
  it.each([
    { applicationId: undefined }, { applicationId: 'bad' }, { subscriptions: undefined }, { update: undefined },
    { subscriptions: { ...notifierSubscriptions, 'pixel-processed': 'bad' } },
    { subscriptions: { ...notifierSubscriptions, 'pixel-rejected': 'bad' } },
    { subscriptions: { ...notifierSubscriptions, 'pixel-rejected': notifierSubscriptions['pixel-processed'] } },
  ])('fails closed on invalid config %j', async (changes) => {
    const { invoke, update, res } = setup(changes);
    await invoke(); expect(res.status).toHaveBeenCalledWith(503); expect(update).not.toHaveBeenCalled();
  });
  it('copies subscription configuration before receiving deliveries', async () => {
    const subscriptions = { ...notifierSubscriptions }; const { invoke, res } = setup({ subscriptions });
    subscriptions['pixel-processed'] = 'changed'; await invoke(); expect(res.status).toHaveBeenCalledWith(204);
  });
  it('restricts path, method and body size before decoding', async () => {
    const { invoke, update, res } = setup();
    await invoke(notifierPush(), { path: '/other' }); expect(res.status).toHaveBeenLastCalledWith(404);
    await invoke(notifierPush(), { method: 'GET' }); expect(res.status).toHaveBeenLastCalledWith(405); expect(res.set).toHaveBeenCalledWith('Allow', 'POST');
    await invoke(notifierPush(), { rawBody: Buffer.alloc(MAX_PUSH_BYTES + 1) }); expect(res.status).toHaveBeenLastCalledWith(413);
    await invoke(notifierPush(), { rawBody: undefined }); expect(res.status).toHaveBeenLastCalledWith(413);
    expect(update).not.toHaveBeenCalled();
  });
  it('exports an unavailable handler without environment configuration', async () => {
    const { res } = setup();
    await handleDiscordNotifier({} as Parameters<HttpFunction>[0], res as unknown as Parameters<HttpFunction>[1]);
    expect(res.status).toHaveBeenCalledWith(503);
  });
  it('builds the configured entry point without a Discord call on invalid input', async () => {
    vi.stubEnv('DISCORD_APPLICATION_ID', testApplication);
    vi.stubEnv('DISCORD_PROCESSED_SUBSCRIPTION', notifierSubscriptions['pixel-processed']);
    vi.stubEnv('DISCORD_REJECTED_SUBSCRIPTION', notifierSubscriptions['pixel-rejected']);
    const request = vi.spyOn(globalThis, 'fetch');
    vi.resetModules(); const { handleDiscordNotifier: entry } = await import('./index');
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const { res } = setup();
    await entry({ path: '/', method: 'POST', body: {}, rawBody: Buffer.from('{}') } as Parameters<HttpFunction>[0], res as unknown as Parameters<HttpFunction>[1]);
    expect(res.status).toHaveBeenCalledWith(400); expect(request).not.toHaveBeenCalled(); expect(stdout).toHaveBeenCalled();
  });
});
