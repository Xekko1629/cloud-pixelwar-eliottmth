import { createHash } from 'node:crypto';
import { COORDINATE_LIMIT, PALETTE } from '@pixelwar/shared/grid';
import type { AdminCommand, DiscordContext } from '@pixelwar/shared/events';

export const MAX_PUSH_BYTES = 128 * 1024;
export type Command =
  | { command: 'draw'; options: { x: number; y: number; color: number } }
  | { command: 'get' | 'snapshot'; options: Record<string, never> }
  | { command: 'admin'; options: AdminCommand };
export interface IncomingCommand {
  event_id: string;
  correlation_id: string;
  occurred_at: string;
  actor: { uid: string; name: string; roles: string[] };
  command: Command;
  discord: DiscordContext;
}
export type InvalidReason = 'invalid_envelope' | 'invalid_data' | 'invalid_event' | 'unknown_command' | 'invalid_options' | 'invalid_attributes';
export class InvalidCommand extends Error {
  constructor(readonly reason: InvalidReason) { super(reason); }
}
export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function snowflake(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value) && BigInt(value) <= 0xffffffffffffffffn;
}
function keys(value: Record<string, unknown>, allowed: string): boolean {
  return Object.keys(value).sort().join(',') === allowed;
}
function integer(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}
function parseCommand(name: unknown, options: unknown): Command {
  if (typeof name !== 'string' || !['draw', 'get', 'snapshot', 'admin'].includes(name)) throw new InvalidCommand('unknown_command');
  if (!record(options)) throw new InvalidCommand('invalid_options');
  if (name === 'draw' && keys(options, 'color,x,y') &&
      integer(options.x, -COORDINATE_LIMIT, COORDINATE_LIMIT) && integer(options.y, -COORDINATE_LIMIT, COORDINATE_LIMIT) &&
      integer(options.color, 1, PALETTE.length)) {
    return { command: 'draw', options: { x: options.x, y: options.y, color: options.color } };
  }
  if ((name === 'get' || name === 'snapshot') && keys(options, '')) return { command: name, options: {} };
  if (name === 'admin') {
    const subcommand = options.subcommand;
    if ((subcommand === 'pause' || subcommand === 'resume' || subcommand === 'clear') && keys(options, 'subcommand')) {
      return { command: 'admin', options: { subcommand } };
    }
    if (subcommand === 'ratelimit' && keys(options, 'limit,subcommand,user') && snowflake(options.user) &&
        integer(options.limit, 0, Number.MAX_SAFE_INTEGER)) {
      return { command: 'admin', options: { subcommand, user: options.user, limit: options.limit } };
    }
    if (subcommand === 'size') {
      if (keys(options, 'subcommand')) return { command: 'admin', options: { subcommand } };
      if (keys(options, 'height,subcommand,width') && integer(options.width, 10_000, COORDINATE_LIMIT) &&
          integer(options.height, 10_000, COORDINATE_LIMIT)) {
        return { command: 'admin', options: { subcommand, width: options.width, height: options.height } };
      }
    }
  }
  throw new InvalidCommand('invalid_options');
}

/** BOT-03 /draw is unchanged. Other commands are a proposed ARCH-03 extension. */
export function parsePush(body: unknown, subscription: string, applicationId: string) {
  if (!record(body) || body.subscription !== subscription || !record(body.message) ||
      typeof body.message.messageId !== 'string' || !/^[1-9][0-9]{0,39}$/.test(body.message.messageId) ||
      typeof body.message.data !== 'string' || body.message.data.length < 1 || body.message.data.length > 64 * 1024) {
    throw new InvalidCommand('invalid_envelope');
  }
  const decoded = Buffer.from(body.message.data, 'base64');
  if (decoded.toString('base64') !== body.message.data) throw new InvalidCommand('invalid_data');
  let event: unknown;
  try { event = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decoded)); }
  catch { throw new InvalidCommand('invalid_data'); }
  if (!record(event) || event.schema_version !== 1 || event.source !== 'discord' || !record(event.actor) ||
      !snowflake(event.actor.uid) || typeof event.actor.name !== 'string' ||
      Array.from(event.actor.name).length < 1 || Array.from(event.actor.name).length > 32 ||
      Buffer.byteLength(event.actor.name, 'utf8') > 128 || !Array.isArray(event.actor.roles) ||
      !event.actor.roles.every(snowflake) || !record(event.payload)) throw new InvalidCommand('invalid_event');
  const payload = event.payload;
  if (payload.application_id !== applicationId || !snowflake(payload.application_id) || !snowflake(payload.interaction_id) ||
      !snowflake(payload.channel_id) || !snowflake(payload.guild_id) || typeof payload.interaction_token !== 'string' ||
      payload.interaction_token.length < 1 || payload.interaction_token.length > 4096) throw new InvalidCommand('invalid_event');
  const bytes = createHash('sha256').update(`pixelwar:discord-command:v1:${applicationId}:${payload.interaction_id}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  const expectedId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  const expectedDate = new Date(Number((BigInt(payload.interaction_id) >> 22n) + 1420070400000n)).toISOString();
  if (event.event_id !== expectedId || event.correlation_id !== expectedId || event.occurred_at !== expectedDate) {
    throw new InvalidCommand('invalid_event');
  }
  const attributes = body.message.attributes;
  if (!record(attributes) || !keys(attributes, 'correlation_id,traceparent') || attributes.correlation_id !== expectedId ||
      typeof attributes.traceparent !== 'string' || !/^00-(?!0{32}-)[a-f0-9]{32}-(?!0{16}-)[a-f0-9]{16}-0[01]$/.test(attributes.traceparent)) {
    throw new InvalidCommand('invalid_attributes');
  }
  const command: IncomingCommand = {
    event_id: expectedId, correlation_id: expectedId, occurred_at: expectedDate,
    actor: { uid: event.actor.uid, name: event.actor.name, roles: [...new Set(event.actor.roles as string[])].sort() },
    command: parseCommand(payload.command, payload.options),
    discord: {
      application_id: payload.application_id, interaction_id: payload.interaction_id,
      guild_id: payload.guild_id, channel_id: payload.channel_id, interaction_token: payload.interaction_token,
    },
  };
  return { command, message_id: body.message.messageId, attributes: { correlation_id: expectedId, traceparent: attributes.traceparent } };
}
