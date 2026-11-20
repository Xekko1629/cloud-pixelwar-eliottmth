import { createHash } from 'node:crypto';
import { canonicalEventId, DEFAULT_MAX_BATCH_PIXELS, parseOccurredAt, regionId } from '@pixelwar/shared/grid';

export const MAX_PUSH_BYTES = 128 * 1024;
export const TOKEN_LIFETIME_MS = 15 * 60_000;
export type ResultType = 'pixel-processed' | 'pixel-rejected';
export type RejectReason = 'paused' | 'rate_limit' | 'out_of_bounds' | 'expired' | 'batch_budget_exceeded';
export interface Subscriptions { 'pixel-processed': string; 'pixel-rejected': string }
export type ResultSummary =
  | { type: 'pixel-processed'; applied_pixels: number; ignored_pixels: number }
  | { type: 'pixel-rejected'; applied_pixels: number; ignored_pixels: number; reason: RejectReason };
interface Identifiers { event_id: string; correlation_id: string; message_id: string; attributes: { correlation_id: string; traceparent: string } }
export type DecodedNotice = Identifiers & { result: ResultSummary } & (
  | { source: 'web' }
  | { source: 'discord'; discord: { application_id: string; interaction_token: string; created_at: number } }
);
export type DiscordNotice = Extract<DecodedNotice, { source: 'discord' }>;
type InvalidReason = 'invalid_envelope' | 'invalid_data' | 'invalid_event' | 'invalid_result' | 'invalid_notification' | 'invalid_attributes';
export class InvalidNotice extends Error {
  constructor(readonly reason: InvalidReason) { super(reason); }
}
export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function snowflake(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value) && BigInt(value) <= 0xffffffffffffffffn;
}
export function validSubscriptions(value: Subscriptions | undefined): value is Subscriptions {
  const valid = (name: unknown) => typeof name === 'string' && /^projects\/[a-z][a-z0-9-]+\/subscriptions\/[a-zA-Z][a-zA-Z0-9._~+%-]{2,254}$/.test(name);
  return !!value && valid(value['pixel-processed']) && valid(value['pixel-rejected']) && value['pixel-processed'] !== value['pixel-rejected'];
}
function uuid(value: unknown): value is string {
  try { return typeof value === 'string' && canonicalEventId(value) === value; }
  catch { return false; }
}
function time(value: unknown): number {
  try {
    if (typeof value !== 'string') throw new Error();
    return parseOccurredAt(value);
  } catch { throw new InvalidNotice('invalid_result'); }
}
function integer(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}
function stableId(namespace: string, key: string): string {
  const bytes = createHash('sha256').update(`${namespace}:${key}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function validRegions(value: unknown): boolean {
  if (!Array.isArray(value) || value.length > DEFAULT_MAX_BATCH_PIXELS || new Set(value).size !== value.length) return false;
  return value.every((id: unknown) => {
    if (typeof id !== 'string' || !/^-?\d+_-?\d+$/.test(id)) return false;
    const [rx, ry] = id.split('_').map(Number);
    try { return regionId(rx, ry) === id; } catch { return false; }
  });
}

/** Independent consumer validation; never trusts a type assertion or the notification URL in a message. */
export function parseNoticePush(body: unknown, subscriptions: Subscriptions, applicationId: string): DecodedNotice {
  if (!record(body) || !Object.values(subscriptions).includes(body.subscription as string) || !record(body.message) ||
      typeof body.message.messageId !== 'string' || !/^[1-9][0-9]{0,39}$/.test(body.message.messageId) ||
      typeof body.message.data !== 'string' || body.message.data.length < 1 || body.message.data.length > 64 * 1024) {
    throw new InvalidNotice('invalid_envelope');
  }
  const bytes = Buffer.from(body.message.data, 'base64');
  if (bytes.toString('base64') !== body.message.data) throw new InvalidNotice('invalid_data');
  let event: unknown;
  try { event = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new InvalidNotice('invalid_data'); }
  if (!record(event) || event.schema_version !== 1 || (event.type !== 'pixel-processed' && event.type !== 'pixel-rejected') ||
      body.subscription !== subscriptions[event.type] || !uuid(event.event_id) || !uuid(event.correlation_id) ||
      (event.source !== 'web' && event.source !== 'discord') || !record(event.actor) || !snowflake(event.actor.uid) ||
      typeof event.actor.name !== 'string' || Array.from(event.actor.name).length < 1 || Array.from(event.actor.name).length > 32 ||
      Buffer.byteLength(event.actor.name, 'utf8') > 128 || !record(event.payload) || !record(event.payload.result)) {
    throw new InvalidNotice('invalid_event');
  }
  const result = event.payload.result;
  const occurred = time(result.occurred_at);
  time(result.processed_at);
  if (result.schema_version !== 1 || result.type !== event.type || result.source !== event.source || result.uid !== event.actor.uid ||
      !uuid(result.event_id) || result.result_id !== `draw-result:${result.event_id}` || event.occurred_at !== result.processed_at ||
      event.event_id !== stableId('pixelwar:draw-result:v1', result.event_id) ||
      !integer(result.canvas_version, 1, Number.MAX_SAFE_INTEGER) ||
      !integer(result.requested_pixels, 1, DEFAULT_MAX_BATCH_PIXELS) ||
      !integer(result.applied_pixels, 0, result.requested_pixels) || !integer(result.ignored_pixels, 0, result.requested_pixels) ||
      !validRegions(result.regions)) throw new InvalidNotice('invalid_result');
  let summary: ResultSummary;
  if (event.type === 'pixel-processed') {
    if (result.reason !== undefined || result.applied_pixels + result.ignored_pixels !== result.requested_pixels ||
        (result.applied_pixels === 0) !== ((result.regions as string[]).length === 0)) throw new InvalidNotice('invalid_result');
    summary = { type: event.type, applied_pixels: result.applied_pixels, ignored_pixels: result.ignored_pixels };
  } else {
    if (result.applied_pixels !== 0 || result.ignored_pixels !== 0 || (result.regions as string[]).length !== 0 ||
        typeof result.reason !== 'string' || !['paused', 'rate_limit', 'out_of_bounds', 'expired', 'batch_budget_exceeded'].includes(result.reason)) {
      throw new InvalidNotice('invalid_result');
    }
    summary = { type: event.type, applied_pixels: 0, ignored_pixels: 0, reason: result.reason as RejectReason };
  }
  const attributes = body.message.attributes;
  if (!record(attributes) || Object.keys(attributes).sort().join(',') !== 'correlation_id,traceparent' ||
      attributes.correlation_id !== event.correlation_id || typeof attributes.traceparent !== 'string' ||
      !/^00-(?!0{32}-)[a-f0-9]{32}-(?!0{16}-)[a-f0-9]{16}-0[01]$/.test(attributes.traceparent)) {
    throw new InvalidNotice('invalid_attributes');
  }
  const identifiers = { event_id: event.event_id, correlation_id: event.correlation_id, message_id: body.message.messageId,
    attributes: { correlation_id: event.correlation_id, traceparent: attributes.traceparent } };
  const context = event.payload.discord;
  if (event.source === 'web') {
    if (context !== undefined) throw new InvalidNotice('invalid_notification');
    return { ...identifiers, source: 'web', result: summary };
  }
  if (!record(context) || context.application_id !== applicationId || !snowflake(context.application_id) ||
      !snowflake(context.interaction_id) || !snowflake(context.guild_id) || !snowflake(context.channel_id) ||
      typeof context.interaction_token !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(context.interaction_token) ||
      context.interaction_token === '.' || context.interaction_token === '..' ||
      stableId(`pixelwar:discord-command:v1:${applicationId}`, context.interaction_id) !== result.event_id ||
      Number((BigInt(context.interaction_id) >> 22n) + 1420070400000n) !== occurred) {
    throw new InvalidNotice('invalid_notification');
  }
  return { ...identifiers, source: 'discord', result: summary,
    discord: { application_id: applicationId, interaction_token: context.interaction_token, created_at: occurred } };
}
