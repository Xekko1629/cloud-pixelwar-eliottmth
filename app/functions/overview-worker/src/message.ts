export const MAX_PUSH_BYTES = 16 * 1024;

export class InvalidTickMessage extends Error {
  constructor(readonly reason: 'invalid_envelope') { super(reason); this.name = 'InvalidTickMessage'; }
}

export interface Tick { message_id: string; published_ms: number }

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * overview-tick is a native Cloud Scheduler message (docs/events.md, section 6): its data is
 * not read. Only the push envelope matters: the right subscription, an id and a publish time.
 */
export function parseTickPush(body: unknown, subscription: string): Tick {
  if (!record(body) || body.subscription !== subscription || !record(body.message) ||
      typeof body.message.messageId !== 'string' || !/^[1-9][0-9]{0,39}$/.test(body.message.messageId) ||
      typeof body.message.publishTime !== 'string') {
    throw new InvalidTickMessage('invalid_envelope');
  }
  const published = Date.parse(body.message.publishTime);
  if (!Number.isFinite(published) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/.test(body.message.publishTime)) {
    throw new InvalidTickMessage('invalid_envelope');
  }
  return { message_id: body.message.messageId, published_ms: published };
}
