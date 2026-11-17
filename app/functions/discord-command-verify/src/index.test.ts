import { describe, expect, it, vi } from 'vitest';
import type { HttpFunction } from '@google-cloud/functions-framework';
import { commandEvent } from '../../discord-proxy/src/event';
import { drawInteraction, testApplication } from '../../../testing/discord-proxy-fixtures';
import { createDiscordCommandVerifyHandler, handleDiscordCommandVerify } from './index';
import { MAX_PUSH_BYTES } from './message';

export const subscription = 'projects/pixelwar-test/subscriptions/discord-command-verify';
export function pushBody(event: unknown = commandEvent(drawInteraction(), testApplication)) {
  return {
    subscription,
    message: {
      messageId: '123456', data: Buffer.from(JSON.stringify(event)).toString('base64'),
      attributes: {
        correlation_id: commandEvent(drawInteraction(), testApplication).event_id,
        traceparent: `00-${'1'.repeat(32)}-${'2'.repeat(16)}-00`,
      },
    },
  };
}

function setup(overrides = {}) {
  const write = vi.fn();
  const handler = createDiscordCommandVerifyHandler({
    environment: 'dev', subscription, applicationId: testApplication, write, ...overrides,
  });
  const res = { status: vi.fn(), json: vi.fn(), send: vi.fn(), set: vi.fn() };
  res.status.mockReturnValue(res); res.set.mockReturnValue(res);
  const invoke = async (body: unknown = pushBody(), changes = {}) => {
    await handler({ path: '/', method: 'POST', body, rawBody: Buffer.from(JSON.stringify(body)), ...changes } as Parameters<HttpFunction>[0],
      res as unknown as Parameters<HttpFunction>[1]);
  };
  return { invoke, res, write };
}

describe('dev-only Discord command verification', () => {
  it('acknowledges a real producer event and logs only validated technical identifiers', async () => {
    const { invoke, res, write } = setup(); await invoke();
    expect(res.status).toHaveBeenCalledWith(204);
    expect(res.send).toHaveBeenCalledWith();
    const event = commandEvent(drawInteraction(), testApplication);
    expect(JSON.parse(write.mock.calls[0][0])).toEqual({
      severity: 'INFO', function: 'discord-command-verify', event_type: 'discord.command.verify.consumed',
      event_id: event.event_id, correlation_id: event.event_id, message_id: '123456',
    });
    expect(write.mock.calls.flat().join('')).not.toMatch(/synthetic-interaction-token|Synthetic user|423456789012345678/);
  });
  it('accepts duplicate deliveries with no side effect beyond another log', async () => {
    const { invoke, write } = setup(); await invoke(); await invoke();
    expect(write).toHaveBeenCalledTimes(2);
    expect(write.mock.calls[0]).toEqual(write.mock.calls[1]);
  });
  it.each([
    null, [], {}, { message: {} }, { ...pushBody(), subscription: 'other' },
    { ...pushBody(), message: { ...pushBody().message, messageId: 'synthetic-interaction-token' } },
    { ...pushBody(), message: { ...pushBody().message, data: '' } },
    { ...pushBody(), message: { ...pushBody().message, data: 'A'.repeat(65540) } },
  ])('rejects an invalid envelope without leaking data: %j', async (body) => {
    const { invoke, res, write } = setup(); await invoke(body);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.send).not.toHaveBeenCalled();
    expect(write.mock.calls.flat().join('')).not.toContain('synthetic-interaction-token');
  });
  it.each(['***', 'e30', 'e30=\n', Buffer.from('not JSON').toString('base64'), '/w=='])('rejects invalid base64, JSON or UTF-8: %s', async (data) => {
    const body = pushBody(); body.message.data = data;
    const { invoke, res } = setup(); await invoke(body);
    expect(res.status).toHaveBeenCalledWith(400);
  });
  const mutations: [string, (event: ReturnType<typeof commandEvent>) => void][] = [
    ['version', (e) => { Object.assign(e, { schema_version: 2 }); }],
    ['source', (e) => { Object.assign(e, { source: 'frontend' }); }],
    ['UUID', (e) => { e.event_id = 'synthetic-interaction-token'; }],
    ['derived UUID', (e) => { e.event_id = 'aaaaaaaa-aaaa-8aaa-aaaa-aaaaaaaaaaaa'; e.correlation_id = e.event_id; }],
    ['correlation', (e) => { e.correlation_id = 'other'; }],
    ['date', (e) => { e.occurred_at = '2026-01-01T00:00:00.000Z'; }],
    ['actor', (e) => { e.actor.uid = '0'; }],
    ['actor overflow', (e) => { e.actor.uid = '18446744073709551616'; }],
    ['name', (e) => { e.actor.name = ''; }],
    ['roles', (e) => { e.actor.roles = ['invalid']; }],
    ['command', (e) => { Object.assign(e.payload, { command: 'get' }); }],
    ['application', (e) => { e.payload.application_id = '223456789012345678'; }],
    ['interaction', (e) => { e.payload.interaction_id = 'invalid'; }],
    ['guild', (e) => { e.payload.guild_id = 'invalid'; }],
    ['channel', (e) => { e.payload.channel_id = 'invalid'; }],
    ['token', (e) => { e.payload.interaction_token = ''; }],
    ['token size', (e) => { e.payload.interaction_token = 'x'.repeat(4097); }],
    ['coordinate', (e) => { e.payload.options.x = Number.MAX_SAFE_INTEGER; }],
    ['fraction', (e) => { e.payload.options.y = 0.5; }],
    ['color', (e) => { e.payload.options.color = 17; }],
    ['missing option', (e) => { Reflect.deleteProperty(e.payload.options, 'x'); }],
    ['extra option', (e) => { Object.assign(e.payload.options, { extra: 1 }); }],
  ];
  it.each(mutations)('rejects invalid event %s without logging its contents', async (_, mutate) => {
    const event = commandEvent(drawInteraction(), testApplication); mutate(event);
    const { invoke, res, write } = setup(); await invoke(pushBody(event));
    expect(res.status).toHaveBeenCalledWith(400);
    expect(JSON.parse(write.mock.calls[0][0])).toEqual({
      severity: 'WARNING', function: 'discord-command-verify', event_type: 'discord.command.verify.rejected', reason: 'invalid_event_schema',
    });
    expect(JSON.stringify([write.mock.calls, res.json.mock.calls])).not.toContain('synthetic-interaction-token');
  });
  it.each([null, {}, { correlation_id: 'wrong', traceparent: pushBody().message.attributes.traceparent },
    { ...pushBody().message.attributes, token: 'synthetic-interaction-token' },
    { ...pushBody().message.attributes, traceparent: `00-${'0'.repeat(32)}-${'2'.repeat(16)}-00` },
    { ...pushBody().message.attributes, traceparent: `00-${'1'.repeat(32)}-${'0'.repeat(16)}-00` },
  ])('rejects invalid transport attributes: %j', async (attributes) => {
    const body = pushBody(); Object.assign(body.message, { attributes });
    const { invoke, res, write } = setup(); await invoke(body);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(write.mock.calls.flat().join('')).not.toContain('synthetic-interaction-token');
  });
  it.each([{ environment: 'prd' }, { environment: undefined }, { applicationId: '' }, { subscription: '' }])('fails closed on configuration: %j', async (overrides) => {
    const { invoke, res, write } = setup(overrides); await invoke();
    expect(res.status).toHaveBeenCalledWith(503); expect(write).not.toHaveBeenCalled();
  });
  it('restricts path, method and raw body size', async () => {
    const { invoke, res, write } = setup();
    await invoke(pushBody(), { path: '/other' }); expect(res.status).toHaveBeenLastCalledWith(404);
    await invoke(pushBody(), { method: 'GET' }); expect(res.status).toHaveBeenLastCalledWith(405);
    expect(res.set).toHaveBeenCalledWith('Allow', 'POST');
    await invoke(pushBody(), { rawBody: Buffer.alloc(MAX_PUSH_BYTES + 1) }); expect(res.status).toHaveBeenLastCalledWith(413);
    await invoke(pushBody(), { rawBody: undefined }); expect(res.status).toHaveBeenLastCalledWith(413);
    expect(write).not.toHaveBeenCalled();
  });
  it('does not acknowledge when writing the consumption log fails', async () => {
    const { invoke, res } = setup({ write: () => { throw new Error('synthetic-interaction-token'); } });
    await invoke(); expect(res.status).toHaveBeenCalledWith(503);
    expect(res.send).not.toHaveBeenCalled();
    expect(JSON.stringify(res.json.mock.calls)).not.toContain('synthetic-interaction-token');
  });
  it('exports an unavailable entry point without configuration', async () => {
    const res = { status: vi.fn(), json: vi.fn() }; res.status.mockReturnValue(res);
    await handleDiscordCommandVerify({} as Parameters<HttpFunction>[0], res as unknown as Parameters<HttpFunction>[1]);
    expect(res.status).toHaveBeenCalledWith(503);
  });
});
