import { describe, expect, it, vi } from 'vitest';
import type { HttpFunction } from '@google-cloud/functions-framework';
import { createDiscordProxyHandler, handleDiscordProxy } from './index';
import { adminInteraction, drawInteraction, signedRequest, testApplication, testNow, testPublicKey } from '../../../testing/discord-proxy-fixtures';

function response() {
  const res = { status: vi.fn(), json: vi.fn(), set: vi.fn(), send: vi.fn() };
  res.status.mockReturnValue(res); res.set.mockReturnValue(res);
  return res;
}
function setup(overrides = {}) {
  const publish = vi.fn().mockResolvedValue('message-id');
  const log = vi.fn();
  const handler = createDiscordProxyHandler({
    publicKey: testPublicKey, applicationId: testApplication, now: () => testNow, publish, log, ...overrides,
  });
  const res = response();
  const invoke = async (req = signedRequest(drawInteraction())) => {
    await handler(req, res as unknown as Parameters<HttpFunction>[1]);
    return res;
  };
  return { publish, log, res, invoke };
}

describe('Q2 Discord proxy', () => {
  it('responds to a signed PING without publishing', async () => {
    const { invoke, publish, res } = setup();
    await invoke(signedRequest({ type: 1, application_id: testApplication }));
    expect(res.json).toHaveBeenCalledWith({ type: 1 });
    expect(publish).not.toHaveBeenCalled();
  });
  it('publishes the validated command with W3C attributes before deferring', async () => {
    const { invoke, publish, res, log } = setup();
    await invoke();
    const [event, attributes] = publish.mock.calls[0];
    expect(event).toMatchObject({
      schema_version: 1, source: 'discord', occurred_at: new Date(testNow).toISOString(),
      actor: { uid: '423456789012345678', name: 'Synthetic user', roles: ['523456789012345678'] },
      payload: { command: 'draw', options: { x: -1, y: 64, color: 3 }, interaction_token: 'synthetic-interaction-token' },
    });
    expect(event.event_id).toMatch(/^[a-f0-9-]{14}8[a-f0-9-]{21}$/);
    expect(attributes.correlation_id).toBe(event.event_id);
    expect(attributes.traceparent).toMatch(/^00-[a-f0-9]{32}-[a-f0-9]{16}-0[01]$/);
    expect(res.json).toHaveBeenCalledWith({ type: 5 });
    expect(publish.mock.invocationCallOrder[0]).toBeLessThan(res.json.mock.invocationCallOrder[0]);
    expect(JSON.stringify(log.mock.calls)).not.toContain('synthetic-interaction-token');
    expect(JSON.stringify(attributes)).not.toContain('synthetic-interaction-token');
  });
  it('waits for actual publication completion, not just the call', async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const { invoke, res } = setup({ publish: () => pending });
    const request = invoke();
    expect(res.json).not.toHaveBeenCalled();
    finish(); await request;
    expect(res.json).toHaveBeenCalledWith({ type: 5 });
  });
  it('keeps identity and occurrence time stable for duplicate deliveries', async () => {
    const { invoke, publish } = setup();
    await invoke(); await invoke();
    expect(publish.mock.calls[0][0]).toEqual(publish.mock.calls[1][0]);
    // This is not a deduplicating proxy: consumers must tolerate both publications.
    expect(publish).toHaveBeenCalledTimes(2);
  });
  it('ignores req.body and checks the signed raw bytes', async () => {
    const { invoke, res } = setup();
    await invoke(signedRequest(` { "type": 1, "application_id": "${testApplication}" } `, { body: { type: 99 } }));
    expect(res.json).toHaveBeenCalledWith({ type: 1 });
  });
  it.each([
    { rawBody: undefined }, { rawBody: Buffer.from('{}') }, { get: () => undefined }, { get: () => 'invalid' },
  ])('rejects unsigned or altered requests without publication: %j', async (changes) => {
    const { invoke, publish, res } = setup();
    await invoke(signedRequest(drawInteraction(), changes));
    expect(res.status).toHaveBeenCalledWith(401); expect(publish).not.toHaveBeenCalled();
  });
  it.each([-301, 301])('rejects an expired/future signature (%i s)', async (offset) => {
    const { invoke, publish, res } = setup();
    await invoke(signedRequest(drawInteraction(), {}, String(testNow / 1000 + offset)));
    expect(res.status).toHaveBeenCalledWith(401); expect(publish).not.toHaveBeenCalled();
  });
  it.each(['not JSON', 'null', '[]', '{}', '{"type":99}', '{"type":1,"application_id":"other"}'])(
    'rejects malformed or misrouted interactions: %s', async (value) => {
      const { invoke, publish, res } = setup(); await invoke(signedRequest(value));
      expect(res.status).toHaveBeenCalledWith(400); expect(publish).not.toHaveBeenCalled();
    },
  );
  it('forwards /admin and defers an answer only its author sees', async () => {
    const { invoke, publish, res } = setup();
    await invoke(signedRequest(adminInteraction('pause')));
    expect(publish.mock.calls[0][0]).toMatchObject({ payload: { command: 'admin', options: { subcommand: 'pause' } } });
    expect(res.json).toHaveBeenCalledWith({ type: 5, data: { flags: 64 } });
  });
  it('answers an incomplete /admin size at once, without publishing', async () => {
    const { invoke, publish, res } = setup();
    await invoke(signedRequest(adminInteraction('size', [{ type: 4, name: 'width', value: 20_000 }])));
    expect(res.json).toHaveBeenCalledWith({ type: 4, data: expect.objectContaining({ flags: 64, content: expect.stringContaining('width') }) });
    expect(publish).not.toHaveBeenCalled();
  });
  it('refuses a malformed /admin with 400, without publishing', async () => {
    const { invoke, publish, res } = setup();
    await invoke(signedRequest(adminInteraction('delete')));
    expect(res.status).toHaveBeenCalledWith(400);
    expect(publish).not.toHaveBeenCalled();
  });
  it.each(['get', 'snapshot', 'hello'])('answers unavailable /%s immediately', async (name) => {
    const interaction = drawInteraction(); interaction.data.name = name;
    const { invoke, publish, res } = setup(); await invoke(signedRequest(interaction));
    expect(res.json).toHaveBeenCalledWith({ type: 4, data: expect.objectContaining({ flags: 64, allowed_mentions: { parse: [] } }) });
    expect(publish).not.toHaveBeenCalled();
  });
  it('does not claim success or expose SDK errors on publication failure', async () => {
    const { invoke, res, log } = setup({ publish: async () => { throw new Error('synthetic-interaction-token'); } });
    await invoke();
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).not.toHaveBeenCalledWith({ type: 5 });
    expect(JSON.stringify([log.mock.calls, res.json.mock.calls])).not.toContain('synthetic-interaction-token');
  });
  it.each([
    { type: 99 }, { type: 2, data: null }, { type: 2, data: { type: 2, name: 'draw' } },
    { type: 2, data: { type: 1, name: 'draw', options: [] } },
  ])('rejects invalid signed commands without publication', async (changes) => {
    const { invoke, res, publish } = setup();
    await invoke(signedRequest({ ...drawInteraction(), ...changes }));
    expect(res.status).toHaveBeenCalledWith(400); expect(publish).not.toHaveBeenCalled();
  });
  it.each([{ publicKey: '' }, { applicationId: '' }, { publish: undefined }])('fails closed when misconfigured: %j', async (config) => {
    const { invoke, res, publish } = setup(config); await invoke();
    expect(res.status).toHaveBeenCalledWith(503); expect(publish).not.toHaveBeenCalled();
  });
  it('answers the warm-up health check without signature, publication or log', async () => {
    const { invoke, publish, log, res } = setup();
    await invoke({ path: '/discord/health', method: 'GET', get: () => undefined } as unknown as Parameters<HttpFunction>[0]);
    expect(res.status).toHaveBeenCalledWith(204);
    expect(publish).not.toHaveBeenCalled(); expect(log).not.toHaveBeenCalled();
  });
  it('answers the health check even without runtime configuration', async () => {
    const res = response();
    await createDiscordProxyHandler({})({ path: '/discord/health', method: 'GET' } as unknown as Parameters<HttpFunction>[0],
      res as unknown as Parameters<HttpFunction>[1]);
    expect(res.status).toHaveBeenCalledWith(204);
  });
  it('refuses another method on the health check', async () => {
    const { invoke, res } = setup();
    await invoke({ path: '/discord/health', method: 'POST', get: () => undefined } as unknown as Parameters<HttpFunction>[0]);
    expect(res.status).toHaveBeenCalledWith(405);
  });
  it('limits the method and path', async () => {
    const { invoke, res, publish } = setup();
    await invoke(signedRequest(drawInteraction(), { path: '/other' }));
    expect(res.status).toHaveBeenCalledWith(404);
    await invoke(signedRequest(drawInteraction(), { method: 'GET' }));
    expect(res.set).toHaveBeenCalledWith('Allow', 'POST'); expect(res.status).toHaveBeenCalledWith(405);
    expect(publish).not.toHaveBeenCalled();
  });
  it('exports a fail-closed entry point without runtime configuration', async () => {
    const res = response();
    await handleDiscordProxy(signedRequest(drawInteraction()), res as unknown as Parameters<HttpFunction>[1]);
    expect(res.status).toHaveBeenCalledWith(503);
  });
});
