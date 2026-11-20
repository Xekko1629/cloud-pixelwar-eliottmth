import { describe, expect, it } from 'vitest';
import { notificationEvent, notifierPush, notifierSubscriptions } from '../../../testing/discord-notifier-fixtures';
import { testApplication } from '../../../testing/discord-proxy-fixtures';
import { parseNoticePush } from './message';

const parse = (body: unknown = notifierPush()) => parseNoticePush(body, notifierSubscriptions, testApplication);
describe('draw result consumer contract', () => {
  it('accepts the actual DRAW-02 result and returns only notification data', () => {
    const event = notificationEvent(); Object.assign(event, { extra: 'never-forward-this' });
    Object.assign(event.payload.result, { extra: 'never-forward-this' });
    Object.assign(event.payload.discord!, { url: 'https://evil.invalid', extra: 'never-forward-this' });
    const parsed = parse(notifierPush(event));
    expect(parsed.source).toBe('discord');
    if (parsed.source === 'discord') expect(parsed.discord.interaction_token).toBe('synthetic-interaction-token');
    expect(parsed.result).toEqual({ type: 'pixel-processed', applied_pixels: 1, ignored_pixels: 0 });
    expect(JSON.stringify(parsed)).not.toMatch(/never-forward-this|evil.invalid|Synthetic user/);
  });
  it('accepts valid web results without treating them as Discord notifications', () => {
    expect(parse(notifierPush(notificationEvent('pixel-processed', 'web'))).source).toBe('web');
  });
  it.each(['paused', 'rate_limit', 'out_of_bounds', 'expired', 'batch_budget_exceeded'] as const)('accepts refusal %s', (reason) => {
    expect(parse(notifierPush(notificationEvent('pixel-rejected', 'discord', reason))).result).toMatchObject({ type: 'pixel-rejected', reason });
  });
  it.each([null, [], {}, { message: {} }, { ...notifierPush(), subscription: 'other' }])('rejects malformed envelopes %j', (body) => {
    expect(() => parse(body)).toThrow('invalid_envelope');
  });
  it.each(['', 'A'.repeat(65540)])('bounds input before decoding', (data) => {
    const body = notifierPush(); body.message.data = data;
    expect(() => parse(body)).toThrow('invalid_envelope');
  });
  it.each(['***', 'e30', '/w==', Buffer.from('not JSON').toString('base64')])('rejects malformed encoding %s', (data) => {
    const body = notifierPush(); body.message.data = data;
    expect(() => parse(body)).toThrow('invalid_data');
  });
  it.each([
    { schema_version: 2 }, { type: 'other' }, { source: 'other' }, { actor: null },
    { actor: { uid: 'other', name: 'Name' } }, { actor: { uid: '123', name: '' } },
    { actor: { uid: '123', name: 'x'.repeat(33) } }, { payload: null }, { payload: { result: null } },
    { event_id: 'other' }, { correlation_id: 'other' },
  ])('rejects invalid envelopes/actor fields %j', (changes) => {
    expect(() => parse(notifierPush({ ...notificationEvent(), ...changes }))).toThrow('invalid_event');
  });
  it('rejects an event delivered through the wrong configured subscription', () => {
    const body = notifierPush(); body.subscription = notifierSubscriptions['pixel-rejected'];
    expect(() => parse(body)).toThrow('invalid_event');
  });
  it.each([
    { schema_version: 2 }, { type: 'pixel-rejected' }, { source: 'web' }, { uid: '123' }, { event_id: 'other' },
    { result_id: 'other' }, { canvas_version: 0 }, { requested_pixels: 0 }, { requested_pixels: 501 },
    { applied_pixels: -1 }, { applied_pixels: 2 }, { ignored_pixels: 1 }, { reason: 'paused' },
    { regions: null }, { regions: [] }, { regions: ['bad'] }, { regions: ['999999999999999999_0'] },
    { processed_at: 'bad' }, { occurred_at: 'bad' }, { processed_at: null },
  ])('rejects inconsistent result fields %j', (changes) => {
    const event = notificationEvent(); Object.assign(event.payload.result, changes);
    expect(() => parse(notifierPush(event))).toThrow();
  });
  it.each([
    { applied_pixels: 1 }, { ignored_pixels: 1 }, { regions: ['0_0'] }, { reason: 'other' }, { reason: undefined },
  ])('rejects inconsistent refusals %j', (changes) => {
    const event = notificationEvent('pixel-rejected'); Object.assign(event.payload.result, changes);
    expect(() => parse(notifierPush(event))).toThrow('invalid_result');
  });
  it.each([
    { application_id: 'other' }, { interaction_id: '0' }, { guild_id: 'other' }, { channel_id: 'other' },
    { interaction_id: '123456789012345678' }, { interaction_token: '' }, { interaction_token: 'x'.repeat(4097) },
    { interaction_token: 'white space' }, { interaction_token: '.' }, { interaction_token: '..' },
  ])('rejects invalid notification context %j', (changes) => {
    const event = notificationEvent(); Object.assign(event.payload.discord!, changes);
    expect(() => parse(notifierPush(event))).toThrow('invalid_notification');
  });
  it('rejects a forged result ID even if formatted as a UUID', () => {
    const event = notificationEvent(); event.event_id = '11111111-1111-4111-8111-111111111111';
    expect(() => parse(notifierPush(event))).toThrow('invalid_result');
  });
  it('rejects mismatched result and envelope dates', () => {
    const event = notificationEvent(); event.occurred_at = '2026-01-01T00:00:00.000Z';
    expect(() => parse(notifierPush(event))).toThrow('invalid_result');
  });
  it('rejects notification metadata on web events', () => {
    const event = notificationEvent('pixel-processed', 'web'); event.payload.discord = notificationEvent().payload.discord;
    expect(() => parse(notifierPush(event))).toThrow('invalid_notification');
  });
  it.each([
    { correlation_id: 'other' }, { traceparent: 'bad' }, { token: 'synthetic-secret' },
    { traceparent: `00-${'0'.repeat(32)}-${'2'.repeat(16)}-00` },
    { traceparent: `00-${'1'.repeat(32)}-${'0'.repeat(16)}-00` },
  ])('rejects unsafe transport attributes %j', (changes) => {
    const body = notifierPush(); Object.assign(body.message.attributes, changes);
    expect(() => parse(body)).toThrow('invalid_attributes');
  });
  it('accepts ignored pixels and sampled trace context', () => {
    const event = notificationEvent(); Object.assign(event.payload.result, { applied_pixels: 0, ignored_pixels: 1, regions: [] });
    const body = notifierPush(event); body.message.attributes.traceparent = body.message.attributes.traceparent.slice(0, -1) + '1';
    expect(parse(body).result).toMatchObject({ applied_pixels: 0, ignored_pixels: 1 });
  });
});
