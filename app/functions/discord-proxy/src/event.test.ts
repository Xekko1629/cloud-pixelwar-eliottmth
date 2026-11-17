import { describe, expect, it } from 'vitest';
import { commandEvent } from './event';
import { drawInteraction, testApplication } from '../../../testing/discord-proxy-fixtures';

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
    { data: null }, { data: { type: 1, name: 'get' } },
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
});
