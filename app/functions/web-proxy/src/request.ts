import { randomUUID } from 'node:crypto';
import { COORDINATE_LIMIT, DEFAULT_MAX_BATCH_PIXELS, PALETTE, type DrawPixel } from '@pixelwar/shared/grid';
import type { GatewayIdentity } from '@pixelwar/shared/gateway';
import type { PixelDrawEvent } from '@pixelwar/shared/events';

// 500 pixels at the coordinate limit take about 23 KiB of JSON: 64 KiB leaves room for
// whitespace while keeping the published message under the draw-worker push limit.
export const MAX_BODY_BYTES = 64 * 1024;
// DATA-02 stores at most 32 Unicode code points as the author name of a pixel (metadata.ts),
// while the session JWT allows 80: keep the longest valid prefix instead of quarantining the draw.
export const MAX_AUTHOR_NAME = 32;

export type InvalidReason = 'invalid_json' | 'invalid_body' | 'too_many_pixels' | 'invalid_pixel' | 'duplicate_pixel';
export class InvalidDrawRequest extends Error {
  constructor(readonly reason: InvalidReason) { super(reason); this.name = 'InvalidDrawRequest'; }
}
export type WebDrawEvent = Extract<PixelDrawEvent, { source: 'web' }>;

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const keys = (value: Record<string, unknown>, expected: string) => Object.keys(value).sort().join(',') === expected;
const integer = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;

/** Fixed bounds only (ADR-0007): the current grid size is checked by DATA-02, which rejects out_of_bounds. */
export function parseDrawBody(body: Buffer, maxPixels = DEFAULT_MAX_BATCH_PIXELS): DrawPixel[] {
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)); }
  catch { throw new InvalidDrawRequest('invalid_json'); }
  if (!record(value) || !keys(value, 'pixels') || !Array.isArray(value.pixels) || value.pixels.length < 1) {
    throw new InvalidDrawRequest('invalid_body');
  }
  // The count always comes from the validated array, never from a client counter (rate-limits.md).
  if (value.pixels.length > maxPixels) throw new InvalidDrawRequest('too_many_pixels');
  const positions = new Set<string>();
  return value.pixels.map((pixel: unknown) => {
    if (!record(pixel) || !keys(pixel, 'color,x,y') ||
        !integer(pixel.x, -COORDINATE_LIMIT, COORDINATE_LIMIT) || !integer(pixel.y, -COORDINATE_LIMIT, COORDINATE_LIMIT) ||
        !integer(pixel.color, 1, PALETTE.length)) {
      throw new InvalidDrawRequest('invalid_pixel');
    }
    // DATA-02 refuses a duplicate coordinate as a malformed command: answer 400 here instead of a DLQ entry.
    const position = `${pixel.x}_${pixel.y}`;
    if (positions.has(position)) throw new InvalidDrawRequest('duplicate_pixel');
    positions.add(position);
    return { x: pixel.x, y: pixel.y, color: pixel.color };
  });
}

/**
 * A new event per request: an HTTP retry is a second draw (same colors, quota counted twice).
 * The browser clock is never trusted: occurred_at is the proxy time (docs/web-proxy.md).
 */
export function webDrawEvent(pixels: DrawPixel[], identity: GatewayIdentity, nowMs: number, newId: () => string = randomUUID): WebDrawEvent {
  const eventId = newId();
  return {
    schema_version: 1, type: 'pixel-draw', event_id: eventId, correlation_id: eventId,
    occurred_at: new Date(nowMs).toISOString(), source: 'web',
    actor: { uid: identity.uid, name: Array.from(identity.name).slice(0, MAX_AUTHOR_NAME).join('') },
    payload: { pixels },
  };
}
