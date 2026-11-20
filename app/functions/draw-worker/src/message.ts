import { createHash } from 'node:crypto';
import { canonicalEventId } from '@pixelwar/shared/grid';
import { DrawProcessingError, type DrawCommand } from '@pixelwar/shared/drawing';
import type { DiscordContext } from '@pixelwar/shared/events';

export const MAX_PUSH_BYTES = 128 * 1024;
export type Attributes = { correlation_id: string; traceparent: string };
export type InvalidReason = 'invalid_envelope' | 'invalid_data' | 'invalid_event' | 'invalid_notification' | 'invalid_attributes';
export class InvalidDrawMessage extends Error {
  constructor(readonly reason: InvalidReason) { super(reason); }
}
export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function snowflake(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value) && BigInt(value) <= 0xffffffffffffffffn;
}

/** Canonical UUIDv8 for a namespace + key. No clock/randomness on retries. */
export function stableId(namespace: string, key: string): string {
  const bytes = createHash('sha256').update(`${namespace}:${key}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function parseDrawPush(body: unknown, subscription: string, applicationId?: string) {
  if (!record(body) || body.subscription !== subscription || !record(body.message) ||
      typeof body.message.messageId !== 'string' || !/^[1-9][0-9]{0,39}$/.test(body.message.messageId) ||
      typeof body.message.data !== 'string' || body.message.data.length < 1 || body.message.data.length > 64 * 1024) {
    throw new InvalidDrawMessage('invalid_envelope');
  }
  const decoded = Buffer.from(body.message.data, 'base64');
  if (decoded.toString('base64') !== body.message.data) throw new InvalidDrawMessage('invalid_data');
  let event: unknown;
  try { event = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decoded)); }
  catch { throw new InvalidDrawMessage('invalid_data'); }
  if (!record(event) || event.schema_version !== 1 || event.type !== 'pixel-draw' ||
      (event.source !== 'web' && event.source !== 'discord') || !record(event.actor) ||
      !snowflake(event.actor.uid) || typeof event.actor.name !== 'string' || typeof event.occurred_at !== 'string' ||
      !record(event.payload) || !Array.isArray(event.payload.pixels) ||
      typeof event.event_id !== 'string' || typeof event.correlation_id !== 'string') {
    throw new InvalidDrawMessage('invalid_event');
  }
  try {
    if (canonicalEventId(event.event_id) !== event.event_id || canonicalEventId(event.correlation_id) !== event.correlation_id) throw new Error();
  } catch { throw new InvalidDrawMessage('invalid_event'); }
  // DATA-02 remains the single owner of coordinate, author, palette and batch validation.
  const command: DrawCommand = {
    event_id: event.event_id, occurred_at: event.occurred_at as string, source: event.source as DrawCommand['source'],
    author: { uid: event.actor.uid as string, name: event.actor.name as string }, pixels: event.payload.pixels,
  };
  let discord: DiscordContext | undefined;
  if (event.source === 'discord') {
    if (!applicationId) throw new Error('Discord application configuration unavailable');
    const context = event.payload.discord;
    if (!record(context) || context.application_id !== applicationId || !snowflake(context.application_id) ||
        !snowflake(context.interaction_id) || !snowflake(context.channel_id) || !snowflake(context.guild_id) ||
        typeof context.interaction_token !== 'string' || context.interaction_token.length < 1 || context.interaction_token.length > 4096 ||
        stableId(`pixelwar:discord-command:v1:${applicationId}`, context.interaction_id) !== event.event_id ||
        new Date(Number((BigInt(context.interaction_id) >> 22n) + 1420070400000n)).toISOString() !== event.occurred_at) {
      throw new InvalidDrawMessage('invalid_notification');
    }
    discord = { application_id: context.application_id, interaction_id: context.interaction_id,
      channel_id: context.channel_id, guild_id: context.guild_id, interaction_token: context.interaction_token };
  } else if (event.payload.discord !== undefined) throw new InvalidDrawMessage('invalid_notification');
  const attrs = body.message.attributes;
  if (!record(attrs) || Object.keys(attrs).sort().join(',') !== 'correlation_id,traceparent' ||
      attrs.correlation_id !== event.correlation_id || typeof attrs.traceparent !== 'string' ||
      !/^00-(?!0{32}-)[a-f0-9]{32}-(?!0{16}-)[a-f0-9]{16}-0[01]$/.test(attrs.traceparent)) {
    throw new InvalidDrawMessage('invalid_attributes');
  }
  return { command, discord, message_id: body.message.messageId,
    attributes: { correlation_id: event.correlation_id, traceparent: attrs.traceparent } as Attributes };
}

export function isInvalidInput(error: unknown): boolean {
  return error instanceof InvalidDrawMessage || error instanceof DrawProcessingError && error.code === 'invalid_command';
}
