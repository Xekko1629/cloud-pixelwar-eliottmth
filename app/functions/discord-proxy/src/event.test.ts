import { describe, expect, it } from 'vitest';
import { commandEvent, MAX_ACTOR_NAME, UserInputError } from './event';
import { adminInteraction, drawInteraction, testApplication } from '../../../testing/discord-proxy-fixtures';

describe('provisional discord-command v1 envelope', () => {
  it('makes different interaction IDs distinct and roles canonical', () => {
    const interaction = drawInteraction();
    interaction.member.roles.push(interaction.member.roles[0]);
    const first = commandEvent(interaction, testApplication);
    interaction.id = String(BigInt(interaction.id) + 1n);
    expect(commandEvent(interaction, testApplication).event_id).not.toBe(first.event_id);
    expect(first.actor.roles).toHaveLength(1);
  });
  it.each([
    { id: '0' }, { id: '18446744073709551616' }, { application_id: 'other' }, { guild_id: null },
    { channel_id: '' }, { token: '' }, { token: 'x'.repeat(4097) }, { member: null },
    { member: { user: { id: 'invalid', username: 'test' }, roles: [] } },
    { member: { user: { id: '123', username: '' }, roles: [] } },
    { member: { user: { id: '123', username: 'test' }, roles: ['invalid'] } },
    { data: null }, { data: { type: 1, name: 'hello' } },
  ])('rejects invalid metadata without echoing it: %j', (changes) => {
    expect(() => commandEvent({ ...drawInteraction(), ...changes }, testApplication)).toThrow();
  });
  it.each([
    undefined, [], [{ type: 4, name: 'x', value: 0 }],
    [{ type: 4, name: 'x', value: 0 }, { type: 4, name: 'x', value: 0 }, { type: 4, name: 'color', value: 1 }],
  ])('rejects missing or duplicate options: %j', (options) => {
    const interaction = drawInteraction();
    expect(() => commandEvent({ ...interaction, data: { ...interaction.data, options } }, testApplication)).toThrow();
  });
  it.each([
    ['x', 1.5], ['x', Number.MAX_SAFE_INTEGER], ['y', -Number.MAX_SAFE_INTEGER],
    ['color', 0], ['color', 17], ['x', '1'], ['x', NaN],
  ])('rejects invalid %s=%s', (name, value) => {
    const interaction = drawInteraction();
    const options = interaction.data.options.map((option) => option.name === name ? { ...option, value } : option);
    expect(() => commandEvent({ ...interaction, data: { ...interaction.data, options } }, testApplication)).toThrow();
  });
  it('cuts a long Discord username to the 32 characters the command-worker accepts', () => {
    const interaction = drawInteraction();
    interaction.member.user.username = 'é'.repeat(40) + '🙂';
    const name = commandEvent(interaction, testApplication).actor.name;
    expect(Array.from(name)).toHaveLength(MAX_ACTOR_NAME);
    expect(name).toBe('é'.repeat(32));
  });
});

describe('/admin subcommands', () => {
  it.each([
    ['pause', undefined, { subcommand: 'pause' }],
    ['clear', [], { subcommand: 'clear' }],
    ['size', undefined, { subcommand: 'size' }],
    ['size', [{ type: 4, name: 'width', value: 20_000 }, { type: 4, name: 'height', value: 30_000 }], { subcommand: 'size', width: 20_000, height: 30_000 }],
    ['ratelimit', [{ type: 6, name: 'user', value: '623456789012345678' }, { type: 4, name: 'limit', value: 0 }], { subcommand: 'ratelimit', user: '623456789012345678', limit: 0 }],
  ])('flattens /admin %s into the command-worker options', (subcommand, options, expected) => {
    const event = commandEvent(adminInteraction(subcommand, options), testApplication);
    expect(event.payload).toMatchObject({ command: 'admin', options: expected });
    expect(event.actor.roles).toEqual(['523456789012345678']);
  });
  it.each([
    ['delete', undefined], ['pause', [{ type: 4, name: 'limit', value: 1 }]],
    ['ratelimit', [{ type: 6, name: 'user', value: '623456789012345678' }]],
    ['ratelimit', [{ type: 4, name: 'user', value: 1 }, { type: 4, name: 'limit', value: 1 }]],
    ['ratelimit', [{ type: 6, name: 'user', value: 'abc' }, { type: 4, name: 'limit', value: 1 }]],
    ['size', [{ type: 4, name: 'width', value: 1.5 }, { type: 4, name: 'height', value: 20_000 }]],
    ['size', [{ type: 4, name: 'width', value: 20_000 }, { type: 4, name: 'width', value: 20_000 }]],
  ])('rejects malformed /admin %s %j', (subcommand, options) => {
    expect(() => commandEvent(adminInteraction(subcommand, options), testApplication)).toThrow();
  });
  it('rejects several subcommands at once', () => {
    const interaction = adminInteraction('pause');
    interaction.data.options.push({ type: 1, name: 'resume' });
    expect(() => commandEvent(interaction, testApplication)).toThrow();
  });
  it('asks for width and height together', () => {
    expect(() => commandEvent(adminInteraction('size', [{ type: 4, name: 'height', value: 20_000 }]), testApplication))
      .toThrow(UserInputError);
  });
});
