import { describe, expect, it } from 'vitest';
import { adminRole, adminSubscription, adminUid, eventPush, routedCommand } from '../../../testing/admin-worker-fixtures';
import { testApplication, testNow } from '../../../testing/discord-proxy-fixtures';
import { InvalidAdminMessage, isAdmin, parseAdminPush, parseOptions, parsePermissions } from './message';

type Mutable = Record<string, any>;
const admin = (options: unknown = { subcommand: 'pause' }) => routedCommand('admin', options) as unknown as Mutable;
const parse = (event: unknown, subscription = adminSubscription, application = testApplication) =>
  parseAdminPush(eventPush(event, subscription), subscription, application);
const reason = (action: () => unknown) => {
  try { action(); } catch (error) { return error instanceof InvalidAdminMessage ? error.reason : 'other'; }
  return 'accepted';
};

describe('admin-requested parsing', () => {
  it.each([
    [{ subcommand: 'pause' }], [{ subcommand: 'resume' }], [{ subcommand: 'clear' }],
    [{ subcommand: 'ratelimit', user: '623456789012345678', limit: 0 }],
    [{ subcommand: 'size' }], [{ subcommand: 'size', width: 10_000, height: 1_000_000_000 }],
  ])('accepts %j as produced by the real router', (options) => {
    const event = admin(options);
    const request = parse(event);
    expect(request).toMatchObject({ event_id: event.event_id, correlation_id: event.event_id, options,
      actor: { uid: adminUid, roles: [adminRole] } });
    expect(request.target).toEqual({ application_id: testApplication, interaction_token: 'synthetic-interaction-token', created_at: testNow });
  });

  it.each([
    ['invalid_envelope', (event: Mutable) => event, 'projects/demo-pixelwar-test/subscriptions/other'],
    ['invalid_event', (event: Mutable) => ({ ...event, type: 'command-rejected' })],
    ['invalid_event', (event: Mutable) => ({ ...event, actor: { uid: event.actor.uid, name: event.actor.name } })],
    ['invalid_event', (event: Mutable) => ({ ...event, actor: { ...event.actor, roles: [adminRole, adminRole] } })],
    ['invalid_event', (event: Mutable) => ({ ...event, correlation_id: '11111111-1111-4111-8111-111111111111' })],
    ['invalid_event', (event: Mutable) => ({ ...event, event_id: event.event_id.toUpperCase(), correlation_id: event.event_id.toUpperCase() })],
    ['invalid_event', (event: Mutable) => ({ ...event, payload: { ...event.payload, extra: true } })],
    ['invalid_options', (event: Mutable) => ({ ...event, payload: { ...event.payload, options: { subcommand: 'delete' } } })],
    ['invalid_notification', (event: Mutable) => ({ ...event, occurred_at: new Date(testNow + 1).toISOString() })],
    ['invalid_notification', (event: Mutable) => ({ ...event, payload: { ...event.payload,
      discord: { ...event.payload.discord, interaction_id: '1100000000000000099' } } })],
    ['invalid_notification', (event: Mutable) => ({ ...event, payload: { ...event.payload,
      discord: { ...event.payload.discord, interaction_token: 'with space' } } })],
  ])('refuses with %s', (expected, change, subscription = adminSubscription) => {
    expect(reason(() => parseAdminPush(eventPush(change(admin()), subscription), adminSubscription, testApplication))).toBe(expected);
  });

  it('refuses a context of another application, malformed data and foreign attributes', () => {
    expect(reason(() => parse(admin(), adminSubscription, '1000000000000000999'))).toBe('invalid_notification');
    const push = eventPush(admin(), adminSubscription);
    expect(reason(() => parseAdminPush({ ...push, message: { ...push.message, data: 'not base64!' } }, adminSubscription, testApplication)))
      .toBe('invalid_data');
    expect(reason(() => parseAdminPush({ ...push, message: { ...push.message, data: Buffer.from('{').toString('base64') } },
      adminSubscription, testApplication))).toBe('invalid_data');
    expect(reason(() => parseAdminPush({ ...push, message: { ...push.message, attributes: { ...push.message.attributes, extra: 'x' } } },
      adminSubscription, testApplication))).toBe('invalid_attributes');
  });
});

describe('admin options', () => {
  it.each([
    { subcommand: 'pause', extra: 1 }, { subcommand: 'ratelimit', user: 'bob', limit: 1 },
    { subcommand: 'ratelimit', user: '623456789012345678', limit: -1 }, { subcommand: 'size', width: 10_000 },
    { subcommand: 'size', width: 9_999, height: 10_000 }, { subcommand: 'size', width: 10_000, height: 1e9 + 1 }, null,
  ])('refuses %j', (options) => {
    expect(() => parseOptions(options)).toThrow(InvalidAdminMessage);
  });
});

describe('allow-list', () => {
  it('reads the same JSON as the command-worker and refuses anything else', () => {
    expect(parsePermissions(JSON.stringify({ user_ids: [adminUid], role_ids: [] }))).toEqual({ user_ids: [adminUid], role_ids: [] });
    for (const value of [undefined, '', '{', '[]', '{"user_ids":[]}', '{"user_ids":["x"],"role_ids":[]}',
      '{"user_ids":[],"role_ids":[],"extra":[]}']) {
      expect(parsePermissions(value)).toBeUndefined();
    }
  });

  it('authorizes by user id or by role, like BOT-04', () => {
    const actor = { uid: adminUid, name: 'Synthetic user', roles: [adminRole] };
    expect(isAdmin(actor, { user_ids: [adminUid], role_ids: [] })).toBe(true);
    expect(isAdmin(actor, { user_ids: [], role_ids: [adminRole] })).toBe(true);
    expect(isAdmin(actor, { user_ids: [], role_ids: [] })).toBe(false);
  });
});
