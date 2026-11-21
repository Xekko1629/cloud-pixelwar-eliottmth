import { DrawProcessingError } from '@pixelwar/shared/drawing';
import { describe, expect, it } from 'vitest';
import { discordDrawEvent, drawPush, drawSubscription, webDrawEvent } from '../../../testing/draw-worker-fixtures';
import { testApplication } from '../../../testing/discord-proxy-fixtures';
import { InvalidDrawMessage, isInvalidInput, parseDrawPush } from './message';

const parse = (body: unknown = drawPush(), applicationId: string | undefined = testApplication) => parseDrawPush(body, drawSubscription, applicationId);
describe('pixel-draw input', () => {
  it('adapts a web event without Discord credentials', () => {
    const input = webDrawEvent();
    const result = parseDrawPush(drawPush(input), drawSubscription);
    expect(result.command).toEqual({ event_id: input.event_id, occurred_at: input.occurred_at, source: 'web', author: input.actor, pixels: input.payload.pixels });
    expect(result.discord).toBeUndefined();
  });
  it('accepts the actual BOT-04 output and allowlists the notification context', () => {
    const event = discordDrawEvent(); Object.assign(event.payload, { extra: 'never-forward-this' });
    if (event.source === 'discord') Object.assign(event.payload.discord, { extra: 'never-forward-this' });
    const result = parse(drawPush(event));
    expect(result.command.source).toBe('discord');
    expect(result.discord?.interaction_token).toBe('synthetic-interaction-token');
    expect(JSON.stringify(result.command)).not.toContain('synthetic-interaction-token');
    expect(JSON.stringify(result)).not.toContain('never-forward-this');
  });
  it.each([null, [], {}, { message: {} }, { ...drawPush(), subscription: 'other' }])('rejects malformed envelope %j', (body) => {
    expect(() => parse(body)).toThrow('invalid_envelope');
  });
  it.each(['', 'A'.repeat(65540)])('bounds encoded body size', (data) => {
    const body = drawPush(); body.message.data = data;
    expect(() => parse(body)).toThrow('invalid_envelope');
  });
  it.each(['***', 'e30', '/w==', Buffer.from('not JSON').toString('base64')])('rejects invalid encoding %s', (data) => {
    const body = drawPush(); body.message.data = data;
    expect(() => parse(body)).toThrow('invalid_data');
  });
  it.each([
    { schema_version: 2 }, { type: 'other' }, { source: 'other' }, { actor: null },
    { actor: { uid: 123, name: 'Name' } }, { actor: { uid: '123', name: 123 } },
    { payload: null }, { payload: { pixels: null } }, { payload: { pixels: [] } },
    { payload: { pixels: [{ x: 0, y: 0, color: 1 }, { x: 1, y: 0, color: 1 }] } }, { occurred_at: 123 },
    { event_id: 'bad' }, { correlation_id: 'bad' }, { event_id: '00000000-0000-0000-0000-000000000000' },
    { event_id: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA' }, { correlation_id: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA' },
  ])('rejects invalid event fields %j', (changes) => {
    expect(() => parse(drawPush({ ...webDrawEvent(), ...changes }))).toThrow('invalid_event');
  });
  it.each([
    { application_id: 'other' }, { interaction_id: '0' }, { channel_id: 'other' }, { guild_id: 'other' },
    { interaction_token: '' }, { interaction_token: 'x'.repeat(4097) }, { interaction_id: '123456789012345678' },
  ])('rejects inconsistent Discord context %j', (changes) => {
    const event = discordDrawEvent();
    if (event.source === 'discord') Object.assign(event.payload.discord, changes);
    expect(() => parse(drawPush(event))).toThrow('invalid_notification');
  });
  it('retries rather than quarantining if Discord configuration is missing', () => {
    expect(() => parseDrawPush(drawPush(discordDrawEvent()), drawSubscription)).toThrow('configuration unavailable');
  });
  it('rejects Discord notification metadata on a web event', () => {
    const event = webDrawEvent(); Object.assign(event.payload, { discord: {} });
    expect(() => parse(drawPush(event))).toThrow('invalid_notification');
  });
  it.each([
    { correlation_id: 'other' }, { traceparent: 'bad' }, { token: 'synthetic-interaction-token' },
    { traceparent: `00-${'0'.repeat(32)}-${'2'.repeat(16)}-00` },
    { traceparent: `00-${'1'.repeat(32)}-${'0'.repeat(16)}-00` },
  ])('rejects invalid propagation %j', (changes) => {
    const body = drawPush(); Object.assign(body.message.attributes, changes);
    expect(() => parse(body)).toThrow('invalid_attributes');
  });
  it('accepts sampled trace context without replacing correlation', () => {
    const body = drawPush(); body.message.attributes.traceparent = body.message.attributes.traceparent.slice(0, -1) + '1';
    expect(parse(body).attributes).toEqual(body.message.attributes);
  });
  it('distinguishes malformed input from technical failures', () => {
    expect(isInvalidInput(new InvalidDrawMessage('invalid_event'))).toBe(true);
    expect(isInvalidInput(new DrawProcessingError('invalid_command', 'bad input'))).toBe(true);
    expect(isInvalidInput(new DrawProcessingError('invalid_state', 'bad state'))).toBe(false);
    expect(isInvalidInput(new Error('temporary outage'))).toBe(false);
  });
});
