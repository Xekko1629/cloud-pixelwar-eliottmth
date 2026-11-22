import { describe, expect, it } from 'vitest';
import { eventPush, routedCommand } from '../../../testing/admin-worker-fixtures';
import { testApplication } from '../../../testing/discord-proxy-fixtures';
import { renderSubscription } from '../../../testing/render-worker-fixtures';
import { InvalidRenderMessage, parseRenderPush } from './message';

const event = () => routedCommand('get', {}) as unknown as Record<string, unknown> & { payload: { discord: Record<string, unknown> } };
const reason = (body: unknown) => {
  try { parseRenderPush(body, renderSubscription, testApplication); } catch (error) { return (error as InvalidRenderMessage).reason; }
  return 'accepted';
};

describe('render-requested v1 (from the real BOT-04 router)', () => {
  it('accepts the routed /get and keeps the token only in the target', () => {
    const routed = event();
    const request = parseRenderPush(eventPush(routed, renderSubscription), renderSubscription, testApplication);
    expect(routed.type).toBe('render-requested');
    expect(request).toMatchObject({ event_id: routed.event_id, correlation_id: routed.event_id, message_id: '456' });
    expect(request.target).toMatchObject({ application_id: testApplication, interaction_token: 'synthetic-interaction-token' });
    expect(JSON.stringify(request.attributes)).not.toContain('synthetic-interaction-token');
  });

  it.each([
    ['another subscription', () => eventPush(event(), 'projects/demo-pixelwar-test/subscriptions/other'), 'invalid_envelope'],
    ['another event type', () => eventPush({ ...event(), type: 'snapshot-requested' }, renderSubscription), 'invalid_event'],
    ['unexpected payload field', () => eventPush({ ...event(), payload: { ...event().payload, options: {} } }, renderSubscription), 'invalid_event'],
    ['another application', () => eventPush({ ...event(), payload: { discord: { ...event().payload.discord, application_id: '999999999999999999' } } }, renderSubscription), 'invalid_notification'],
    ['another interaction', () => eventPush({ ...event(), payload: { discord: { ...event().payload.discord, interaction_id: '1593540240998400001' } } }, renderSubscription), 'invalid_notification'],
    ['a mismatched correlation attribute', () => eventPush(event(), renderSubscription, 'other'), 'invalid_attributes'],
  ])('refuses %s', (_name, body, expected) => {
    expect(reason(body())).toBe(expected);
  });

  it('refuses non-canonical base64', () => {
    const body = eventPush(event(), renderSubscription);
    body.message.data = `${body.message.data}\n`;
    expect(reason(body)).toBe('invalid_data');
  });
});
