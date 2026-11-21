import { describe, expect, it } from 'vitest';
import { commandFixture, commandPush, commandSubscription, noAdmins } from '../../../testing/command-worker-fixtures';
import { testApplication } from '../../../testing/discord-proxy-fixtures';
import { parsePush } from './message';
import { routeCommand, type Permissions } from './route';

const read = (name = 'draw', options: unknown = { x: -1, y: 64, color: 3 }) =>
  parsePush(commandPush(commandFixture(name, options)), commandSubscription, testApplication).command;

describe('command routing', () => {
  it('preserves the source identity/time and produces a draw batch for DATA-02', () => {
    const input = read(); const result = routeCommand(input, noAdmins);
    expect(result).toMatchObject({ type: 'pixel-draw', source: 'discord', event_id: input.event_id,
      correlation_id: input.correlation_id, occurred_at: input.occurred_at,
      payload: { pixels: [{ x: -1, y: 64, color: 3 }], discord: input.discord } });
    expect(result.actor).toEqual({ uid: input.actor.uid, name: input.actor.name });
  });
  it('publishes the same business identity on retries, not the Pub/Sub message ID', () => {
    expect(routeCommand(read(), noAdmins)).toEqual(routeCommand(read(), noAdmins));
  });
  it('keeps the Discord roles in admin-requested only, for the admin-worker re-check', () => {
    const admin = read('admin', { subcommand: 'pause' });
    const routed = routeCommand(admin, { user_ids: [admin.actor.uid], role_ids: [] });
    expect(routed.actor).toEqual({ uid: admin.actor.uid, name: admin.actor.name, roles: admin.actor.roles });
    expect(admin.actor.roles.length).toBeGreaterThan(0);
    for (const other of [routeCommand(read('get', {}), noAdmins), routeCommand(read('admin', { subcommand: 'pause' }), noAdmins)]) {
      expect(other.actor).not.toHaveProperty('roles');
    }
  });
  it('routes get without an admin privilege', () => {
    expect(routeCommand(read('get', {}), noAdmins).type).toBe('render-requested');
  });
  it.each(['admin', 'snapshot'])('denies %s by default with a notification event', (name) => {
    const command = read(name, name === 'admin' ? { subcommand: 'clear' } : {});
    expect(routeCommand(command, noAdmins)).toMatchObject({ type: 'command-rejected', payload: { command: name, reason: 'unauthorized' } });
  });
  it('authorizes by exact user ID or configured role, not Discord UI permissions', () => {
    const command = read('admin', { subcommand: 'clear' });
    expect(routeCommand(command, { user_ids: [command.actor.uid], role_ids: [] }).type).toBe('admin-requested');
    expect(routeCommand(command, { user_ids: [], role_ids: [command.actor.roles[0]] }).type).toBe('admin-requested');
    expect(routeCommand(command, { user_ids: ['123'], role_ids: ['456'] }).type).toBe('command-rejected');
  });
  it('routes an authorized snapshot with the same restricted policy as BOT-02', () => {
    const command = read('snapshot', {});
    expect(routeCommand(command, { user_ids: [command.actor.uid], role_ids: [] }).type).toBe('snapshot-requested');
  });
  it('copies authorized admin options and notification context', () => {
    const command = read('admin', { subcommand: 'size', width: 10_000, height: 20_000 });
    const event = routeCommand(command, { user_ids: [command.actor.uid], role_ids: [] });
    expect(event.type).toBe('admin-requested');
    if (command.command.command === 'admin') command.command.options.subcommand = 'clear';
    command.discord.interaction_token = 'changed';
    expect(event).toMatchObject({ payload: { options: { subcommand: 'size' }, discord: { interaction_token: 'synthetic-interaction-token' } } });
  });
  it.each([{ user_ids: ['invalid'], role_ids: [] }, { user_ids: [], role_ids: ['invalid'] }, { user_ids: null, role_ids: [] }])('fails closed on invalid authorization config %j', (permissions) => {
    expect(() => routeCommand(read(), permissions as unknown as Permissions)).toThrow('authorization');
  });
});
