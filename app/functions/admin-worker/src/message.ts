import { createHash } from 'node:crypto';
import { snowflakeTime, type OriginalResponseTarget } from '@pixelwar/shared/discord';
import type { AdminCommand } from '@pixelwar/shared/events';
import { COORDINATE_LIMIT, canonicalEventId } from '@pixelwar/shared/grid';

export const MAX_PUSH_BYTES = 128 * 1024;
export type InvalidReason = 'invalid_envelope' | 'invalid_data' | 'invalid_event' | 'invalid_options' | 'invalid_notification' | 'invalid_attributes';
export class InvalidAdminMessage extends Error {
  constructor(readonly reason: InvalidReason) { super(reason); this.name = 'InvalidAdminMessage'; }
}
export interface Permissions { user_ids: readonly string[]; role_ids: readonly string[] }
export interface AdminRequest {
  event_id: string;
  correlation_id: string;
  message_id: string;
  attributes: { correlation_id: string; traceparent: string };
  actor: { uid: string; name: string; roles: string[] };
  options: AdminCommand;
  /** Secret token inside: never logged, stored or put in a span. */
  target: OriginalResponseTarget;
}

export const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
export const snowflake = (value: unknown): value is string =>
  typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value) && BigInt(value) <= 0xffffffffffffffffn;
const keys = (value: Record<string, unknown>, expected: string) => Object.keys(value).sort().join(',') === expected;
const integer = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;

export function validPermissions(value: unknown): value is Permissions {
  return record(value) && keys(value, 'role_ids,user_ids') && Array.isArray(value.user_ids) && value.user_ids.every(snowflake) &&
    Array.isArray(value.role_ids) && value.role_ids.every(snowflake);
}
export function parsePermissions(json: string | undefined): Permissions | undefined {
  if (!json) return undefined;
  try { const value: unknown = JSON.parse(json); return validPermissions(value) ? value : undefined; } catch { return undefined; }
}
/** Same rule as BOT-04: an allow-listed user id OR an allow-listed role. */
export function isAdmin(actor: AdminRequest['actor'], permissions: Permissions): boolean {
  return permissions.user_ids.includes(actor.uid) || actor.roles.some((role) => permissions.role_ids.includes(role));
}

function stableId(namespace: string, key: string): string {
  const bytes = createHash('sha256').update(`${namespace}:${key}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Independent re-validation of the BOT-04 contract (docs/events.md, section 3.6). */
export function parseOptions(options: unknown): AdminCommand {
  if (record(options)) {
    const { subcommand } = options;
    if ((subcommand === 'pause' || subcommand === 'resume' || subcommand === 'clear') && keys(options, 'subcommand')) return { subcommand };
    if (subcommand === 'ratelimit' && keys(options, 'limit,subcommand,user') && snowflake(options.user) &&
        integer(options.limit, 0, Number.MAX_SAFE_INTEGER)) {
      return { subcommand, user: options.user, limit: options.limit };
    }
    if (subcommand === 'size' && keys(options, 'subcommand')) return { subcommand };
    if (subcommand === 'size' && keys(options, 'height,subcommand,width') &&
        integer(options.width, 10_000, COORDINATE_LIMIT) && integer(options.height, 10_000, COORDINATE_LIMIT)) {
      return { subcommand, width: options.width, height: options.height };
    }
  }
  throw new InvalidAdminMessage('invalid_options');
}

export function parseAdminPush(body: unknown, subscription: string, applicationId: string): AdminRequest {
  if (!record(body) || body.subscription !== subscription || !record(body.message) ||
      typeof body.message.messageId !== 'string' || !/^[1-9][0-9]{0,39}$/.test(body.message.messageId) ||
      typeof body.message.data !== 'string' || body.message.data.length < 1 || body.message.data.length > 64 * 1024) {
    throw new InvalidAdminMessage('invalid_envelope');
  }
  const decoded = Buffer.from(body.message.data, 'base64');
  if (decoded.toString('base64') !== body.message.data) throw new InvalidAdminMessage('invalid_data');
  let event: unknown;
  try { event = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decoded)); }
  catch { throw new InvalidAdminMessage('invalid_data'); }
  if (!record(event) || event.schema_version !== 1 || event.type !== 'admin-requested' || event.source !== 'discord' ||
      typeof event.event_id !== 'string' || event.correlation_id !== event.event_id || typeof event.occurred_at !== 'string' ||
      !record(event.actor) || !keys(event.actor, 'name,roles,uid') || !snowflake(event.actor.uid) ||
      typeof event.actor.name !== 'string' || Array.from(event.actor.name).length < 1 || Array.from(event.actor.name).length > 32 ||
      !Array.isArray(event.actor.roles) || !event.actor.roles.every(snowflake) ||
      new Set(event.actor.roles).size !== event.actor.roles.length ||
      !record(event.payload) || !keys(event.payload, 'discord,options')) {
    throw new InvalidAdminMessage('invalid_event');
  }
  try { if (canonicalEventId(event.event_id) !== event.event_id) throw new Error(); }
  catch { throw new InvalidAdminMessage('invalid_event'); }
  const options = parseOptions(event.payload.options);
  const context = event.payload.discord;
  // The context must come from this application and from the very interaction of the event.
  if (!record(context) || context.application_id !== applicationId || !snowflake(context.application_id) ||
      !snowflake(context.interaction_id) || !snowflake(context.guild_id) || !snowflake(context.channel_id) ||
      typeof context.interaction_token !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(context.interaction_token) ||
      context.interaction_token === '.' || context.interaction_token === '..' ||
      stableId(`pixelwar:discord-command:v1:${applicationId}`, context.interaction_id) !== event.event_id ||
      new Date(snowflakeTime(context.interaction_id)).toISOString() !== event.occurred_at) {
    throw new InvalidAdminMessage('invalid_notification');
  }
  const attributes = body.message.attributes;
  if (!record(attributes) || !keys(attributes, 'correlation_id,traceparent') || attributes.correlation_id !== event.correlation_id ||
      typeof attributes.traceparent !== 'string' ||
      !/^00-(?!0{32}-)[a-f0-9]{32}-(?!0{16}-)[a-f0-9]{16}-0[01]$/.test(attributes.traceparent)) {
    throw new InvalidAdminMessage('invalid_attributes');
  }
  return {
    event_id: event.event_id, correlation_id: event.event_id, message_id: body.message.messageId,
    attributes: { correlation_id: event.event_id, traceparent: attributes.traceparent },
    actor: { uid: event.actor.uid, name: event.actor.name, roles: [...event.actor.roles as string[]] },
    options,
    target: { application_id: applicationId, interaction_token: context.interaction_token, created_at: snowflakeTime(context.interaction_id) },
  };
}
