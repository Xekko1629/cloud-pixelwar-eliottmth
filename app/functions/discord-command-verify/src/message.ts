import { createHash } from 'node:crypto';
import { COORDINATE_LIMIT, PALETTE } from '@pixelwar/shared/grid';

// Local diagnostic limits, not Pub/Sub service limits. Bound before decoding.
export const MAX_PUSH_BYTES = 128 * 1024;
const MAX_DATA_CHARACTERS = 64 * 1024;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function snowflake(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value) && BigInt(value) <= 0xffffffffffffffffn;
}

type Reason = 'invalid_envelope' | 'invalid_data' | 'invalid_event_schema' | 'invalid_attributes';
export class InvalidMessage extends Error {
  constructor(readonly reason: Reason) { super(reason); }
}

/** Independent reader of provisional discord-command v1; never returns sensitive fields. */
export function validatePush(body: unknown, subscription: string, applicationId: string) {
  if (!record(body) || body.subscription !== subscription || !record(body.message) ||
      typeof body.message.messageId !== 'string' || !/^[1-9][0-9]{0,39}$/.test(body.message.messageId) ||
      typeof body.message.data !== 'string' || body.message.data.length === 0 ||
      body.message.data.length > MAX_DATA_CHARACTERS) throw new InvalidMessage('invalid_envelope');
  const { data, attributes, messageId } = body.message;
  // Buffer.from alone silently accepts malformed base64. Require canonical encoding.
  const decoded = Buffer.from(data, 'base64');
  if (decoded.toString('base64') !== data) throw new InvalidMessage('invalid_data');
  let event: unknown;
  try {
    event = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decoded));
  } catch { throw new InvalidMessage('invalid_data'); }
  if (!record(event) || event.schema_version !== 1 || event.source !== 'discord' ||
      typeof event.event_id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-8[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(event.event_id) ||
      event.correlation_id !== event.event_id || !record(event.actor) || !snowflake(event.actor.uid) ||
      typeof event.actor.name !== 'string' || event.actor.name.length < 1 || event.actor.name.length > 80 ||
      !Array.isArray(event.actor.roles) || !event.actor.roles.every(snowflake) ||
      !record(event.payload)) throw new InvalidMessage('invalid_event_schema');
  const payload = event.payload;
  if (payload.command !== 'draw' || payload.application_id !== applicationId || !snowflake(payload.application_id) ||
      !snowflake(payload.interaction_id) || !snowflake(payload.guild_id) || !snowflake(payload.channel_id) ||
      typeof payload.interaction_token !== 'string' || payload.interaction_token.length < 1 || payload.interaction_token.length > 4096 ||
      !record(payload.options) || Object.keys(payload.options).sort().join(',') !== 'color,x,y') {
    throw new InvalidMessage('invalid_event_schema');
  }
  const { x, y, color } = payload.options;
  if (typeof x !== 'number' || typeof y !== 'number' || typeof color !== 'number' ||
      ![x, y, color].every(Number.isSafeInteger) || Math.abs(x) > COORDINATE_LIMIT || Math.abs(y) > COORDINATE_LIMIT ||
      color < 1 || color > PALETTE.length) throw new InvalidMessage('invalid_event_schema');
  // Deliberately recomputed independently from the producer to check wire compatibility.
  const bytes = createHash('sha256').update(`pixelwar:discord-command:v1:${applicationId}:${payload.interaction_id}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  const expectedId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  const expectedDate = new Date(Number((BigInt(payload.interaction_id) >> 22n) + 1420070400000n)).toISOString();
  if (event.event_id !== expectedId || event.occurred_at !== expectedDate) throw new InvalidMessage('invalid_event_schema');
  // Only these transport attributes are permitted; no arbitrary attributes are logged.
  if (!record(attributes) || Object.keys(attributes).sort().join(',') !== 'correlation_id,traceparent' ||
      attributes.correlation_id !== event.event_id || typeof attributes.traceparent !== 'string' ||
      !/^00-(?!0{32}-)[a-f0-9]{32}-(?!0{16}-)[a-f0-9]{16}-00$/.test(attributes.traceparent)) {
    throw new InvalidMessage('invalid_attributes');
  }
  return { event_id: event.event_id, correlation_id: event.event_id, message_id: messageId };
}
