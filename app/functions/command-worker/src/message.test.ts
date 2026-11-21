import { describe, expect, it } from 'vitest';
import { commandFixture, commandPush, commandSubscription } from '../../../testing/command-worker-fixtures';
import { adminInteraction, testApplication } from '../../../testing/discord-proxy-fixtures';
import { commandEvent } from '../../discord-proxy/src/event';
import { parsePush } from './message';

const parse = (body: unknown = commandPush()) => parsePush(body, commandSubscription, testApplication);

describe('discord-command reader', () => {
  it('accepts the actual BOT-03 draw wire format and strips unrecognized fields', () => {
    const event = commandFixture(); Object.assign(event, { unrelated: 'never-forward-this' });
    Object.assign(event.actor, { unrelated: 'never-forward-this' });
    Object.assign(event.payload, { unrelated: 'never-forward-this' });
    const parsed = parse(commandPush(event));
    expect(parsed.command.command).toEqual({ command: 'draw', options: { x: -1, y: 64, color: 3 } });
    expect(parsed.command.discord.interaction_token).toBe('synthetic-interaction-token');
    expect(JSON.stringify(parsed)).not.toContain('never-forward-this');
  });
  it.each([
    ['get', {}], ['snapshot', {}], ['admin', { subcommand: 'pause' }], ['admin', { subcommand: 'resume' }],
    ['admin', { subcommand: 'clear' }], ['admin', { subcommand: 'size' }],
    ['admin', { subcommand: 'size', width: 10_000, height: 10_000 }],
    ['admin', { subcommand: 'ratelimit', user: '123456789012345678', limit: 0 }],
  ])('accepts the proposed %s command options %j', (name, options) => {
    expect(parse(commandPush(commandFixture(String(name), options))).command.command).toEqual({ command: name, options });
  });
  it.each([
    ['other', {}], ['draw', null], ['get', { extra: 1 }], ['snapshot', { extra: 1 }],
    ['draw', { x: 0, y: 0, color: 0 }], ['draw', { x: 0.5, y: 0, color: 1 }],
    ['draw', { x: 1_000_000_001, y: 0, color: 1 }], ['draw', { x: 0, y: 0, color: 17 }],
    ['draw', { x: 0, y: 0 }], ['draw', { x: 0, y: 0, color: 1, extra: 1 }],
    ['admin', { subcommand: 'other' }], ['admin', { subcommand: 'clear', extra: 1 }],
    ['admin', { subcommand: 'size', width: 10_000 }], ['admin', { subcommand: 'size', width: 1, height: 1 }],
    ['admin', { subcommand: 'ratelimit', user: 'invalid', limit: 20 }],
    ['admin', { subcommand: 'ratelimit', user: '123', limit: -1 }],
  ])('rejects invalid command %s with options %j', (name, options) => {
    expect(() => parse(commandPush(commandFixture(String(name), options)))).toThrow();
  });
  it.each([null, [], {}, { message: {} }, { ...commandPush(), subscription: 'other' }])('rejects an invalid envelope %j', (body) => {
    expect(() => parse(body)).toThrow('invalid_envelope');
  });
  it.each(['', 'A'.repeat(65540)])('bounds encoded input before decoding', (data) => {
    const body = commandPush(); body.message.data = data;
    expect(() => parse(body)).toThrow('invalid_envelope');
  });
  it.each(['***', 'e30', '/w==', Buffer.from('not JSON').toString('base64')])('rejects invalid base64/UTF-8/JSON %s', (data) => {
    const body = commandPush(); body.message.data = data;
    expect(() => parse(body)).toThrow('invalid_data');
  });
  it.each([
    (e: ReturnType<typeof commandFixture>) => { Object.assign(e, { schema_version: 2 }); },
    (e: ReturnType<typeof commandFixture>) => { Object.assign(e, { source: 'web' }); },
    (e: ReturnType<typeof commandFixture>) => { e.event_id = 'other'; },
    (e: ReturnType<typeof commandFixture>) => { e.correlation_id = 'other'; },
    (e: ReturnType<typeof commandFixture>) => { e.occurred_at = '2000-01-01T00:00:00.000Z'; },
    (e: ReturnType<typeof commandFixture>) => { e.actor.uid = 'invalid'; },
    (e: ReturnType<typeof commandFixture>) => { e.actor.name = ''; },
    (e: ReturnType<typeof commandFixture>) => { e.actor.name = 'x'.repeat(33); },
    (e: ReturnType<typeof commandFixture>) => { e.actor.roles = ['invalid']; },
    (e: ReturnType<typeof commandFixture>) => { e.payload.application_id = '223456789012345678'; },
    (e: ReturnType<typeof commandFixture>) => { e.payload.interaction_id = '0'; },
    (e: ReturnType<typeof commandFixture>) => { e.payload.channel_id = '18446744073709551616'; },
    (e: ReturnType<typeof commandFixture>) => { e.payload.guild_id = 'invalid'; },
    (e: ReturnType<typeof commandFixture>) => { e.payload.interaction_token = ''; },
    (e: ReturnType<typeof commandFixture>) => { e.payload.interaction_token = 'x'.repeat(4097); },
  ])('rejects schema mutation #%#', (mutate) => {
    const event = commandFixture(); mutate(event);
    expect(() => parse(commandPush(event))).toThrow('invalid_event');
  });
  it.each([
    {}, { correlation_id: 'wrong' }, { token: 'synthetic-secret' },
    { traceparent: `00-${'0'.repeat(32)}-${'2'.repeat(16)}-00` },
    { traceparent: `00-${'1'.repeat(32)}-${'0'.repeat(16)}-00` },
    { traceparent: 'invalid' },
  ])('rejects invalid propagation attributes %j', (changes) => {
    const body = commandPush(); Object.assign(body.message.attributes, changes);
    if (Object.keys(changes).length === 0) Object.assign(body.message, { attributes: {} });
    expect(() => parse(body)).toThrow('invalid_attributes');
  });
  it('preserves sampled trace context and canonicalizes roles', () => {
    const event = commandFixture(); event.actor.roles.push(event.actor.roles[0]);
    const body = commandPush(event); body.message.attributes.traceparent = body.message.attributes.traceparent.slice(0, -1) + '1';
    const result = parse(body);
    expect(result.command.actor.roles).toHaveLength(1);
    expect(result.attributes.traceparent.endsWith('-01')).toBe(true);
  });
});

describe('contract with the real discord-proxy for /admin', () => {
  it.each([
    ['pause', undefined, { subcommand: 'pause' }],
    ['size', undefined, { subcommand: 'size' }],
    ['size', [{ type: 4, name: 'width', value: 20_000 }, { type: 4, name: 'height', value: 30_000 }], { subcommand: 'size', width: 20_000, height: 30_000 }],
    ['ratelimit', [{ type: 6, name: 'user', value: '623456789012345678' }, { type: 4, name: 'limit', value: 5 }], { subcommand: 'ratelimit', user: '623456789012345678', limit: 5 }],
  ])('accepts /admin %s as published by the proxy', (subcommand, options, expected) => {
    const event = commandEvent(adminInteraction(subcommand, options), testApplication);
    const { command } = parsePush(commandPush(event), commandSubscription, testApplication);
    expect(command.command).toEqual({ command: 'admin', options: expected });
    expect(command.actor.roles).toEqual(['523456789012345678']);
  });
  it('accepts the 32-character name the proxy cuts from a long username', () => {
    const interaction = adminInteraction('pause');
    interaction.member.user.username = 'x'.repeat(80);
    const { command } = parsePush(commandPush(commandEvent(interaction, testApplication)), commandSubscription, testApplication);
    expect(command.actor.name).toBe('x'.repeat(32));
  });
});
