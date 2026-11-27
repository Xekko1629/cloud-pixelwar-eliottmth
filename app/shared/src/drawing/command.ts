import { createHash } from 'node:crypto';
import { Timestamp } from '@google-cloud/firestore';
import {
  DEFAULT_MAX_BATCH_PIXELS, canonicalEventId, createPixelMetadata, groupPixelsByTile,
  parseOccurredAt, type DrawPixel, type PixelMetadata, type RateLimitDecision,
} from '../grid';

export const DAY_MS = 86_400_000;
export const MAX_DRAW_AGE_MS = 14 * DAY_MS;
export const RESULT_RETENTION_MS = 15 * DAY_MS;
export const MAX_FUTURE_SKEW_MS = 5_000;

export interface DrawCommand {
  event_id: string;
  occurred_at: string;
  source: 'web' | 'discord';
  author: { uid: string; name: string };
  pixels: readonly DrawPixel[];
}
export interface DrawResult {
  schema_version: 1;
  result_id: string;
  event_id: string;
  occurred_at: string;
  processed_at: string;
  source: 'web' | 'discord';
  uid: string;
  canvas_version: number;
  type: 'pixel-processed' | 'pixel-rejected';
  requested_pixels: number;
  applied_pixels: number;
  ignored_pixels: number;
  regions: string[];
  reason?: 'expired' | 'paused' | 'out_of_bounds' | 'batch_budget_exceeded' | 'rate_limit';
  quota?: RateLimitDecision;
}
export class DrawProcessingError extends Error {
  readonly code: 'invalid_command' | 'invalid_state' | 'invalid_clock' | 'event_id_conflict' | 'future_event';
  constructor(code: DrawProcessingError['code'], message: string) {
    super(message);
    this.name = 'DrawProcessingError';
    this.code = code;
  }
}

export interface DrawOptions {
  /** Optional document root for isolated tenants/tests, e.g. draw_tests/<uuid>. */
  root?: string;
  now?: () => number;
  max_pixels?: number;
  max_write_documents?: number;
  max_estimated_bytes?: number;
  delta_ttl_ms?: number;
  /**
   * Sources whose quota was already reserved before publication (ADR-0017): the worker
   * neither evaluates nor consumes it for them. Default: none, every pixel is counted here.
   */
  reserved_sources?: readonly DrawCommand['source'][];
}

export function drawOptions(options: DrawOptions) {
  const result = {
    root: options.root ?? '', now: options.now ?? Date.now,
    max_pixels: options.max_pixels ?? DEFAULT_MAX_BATCH_PIXELS,
    max_write_documents: options.max_write_documents ?? 450,
    max_estimated_bytes: options.max_estimated_bytes ?? 8 * 1024 * 1024,
    delta_ttl_ms: options.delta_ttl_ms ?? 3_600_000,
    reserved_sources: new Set<DrawCommand['source']>(options.reserved_sources ?? []),
  };
  for (const source of result.reserved_sources) {
    if (source !== 'web' && source !== 'discord') throw new Error('reserved_sources only accepts web and discord');
  }
  for (const value of [result.max_pixels, result.max_write_documents, result.max_estimated_bytes, result.delta_ttl_ms]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error('Draw budgets and TTL must be positive safe integers');
  }
  if (result.root && !/^[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+)*$/.test(result.root)) {
    throw new Error('root must be an empty string or a safe Firestore document path');
  }
  return result;
}

export function prepareDraw(command: DrawCommand, maxPixels: number) {
  try {
    const event_id = canonicalEventId(command.event_id);
    const occurred_ms = parseOccurredAt(command.occurred_at);
    if (!['web', 'discord'].includes(command.source) || !Array.isArray(command.pixels)) throw new Error('Invalid source or pixels');
    const metadata = createPixelMetadata(command.author, { event_id, occurred_at: command.occurred_at }, Timestamp.fromMillis);
    // Validate bounds/palette/duplicates and take copies before any asynchronous work.
    const pixels = [...groupPixelsByTile(command.pixels, 1, maxPixels).values()]
      .flatMap((tile) => tile.pixels).sort((a, b) => a.x - b.x || a.y - b.y);
    const stable: DrawCommand = {
      event_id, occurred_at: command.occurred_at, source: command.source,
      author: { uid: command.author.uid, name: command.author.name }, pixels,
    };
    // Versioned fixed-position JSON of validated integers/strings; no credentials,
    // delivery metadata, trace headers or arbitrary properties of the input.
    const request_digest = createHash('sha256').update(JSON.stringify([
      1, event_id, stable.occurred_at, stable.source, stable.author.uid, stable.author.name,
      pixels.map(({ x, y, color }) => [x, y, color]),
    ])).digest('hex');
    return { ...stable, occurred_ms, request_digest, metadata };
  } catch {
    throw new DrawProcessingError('invalid_command', 'Malformed draw command; quarantine instead of partially drawing');
  }
}
export type PreparedDraw = ReturnType<typeof prepareDraw>;

export function processingTime(clock: () => number, deltaTtl: number): number {
  const now = clock();
  try {
    if (!Number.isSafeInteger(now) || now < 0) throw new Error();
    Timestamp.fromMillis(now + Math.max(RESULT_RETENTION_MS, deltaTtl));
  } catch {
    throw new DrawProcessingError('invalid_clock', 'Worker time and retention must fit Firestore timestamps');
  }
  return now;
}

export function assertNotFuture(command: PreparedDraw, now: number): void {
  if (command.occurred_ms > now + MAX_FUTURE_SKEW_MS) {
    throw new DrawProcessingError('future_event', 'Draw timestamp exceeds worker clock tolerance');
  }
}

/** Validates the stored decision before returning it, even after logical TTL expiry. */
export function storedResult(data: Record<string, unknown>, command: PreparedDraw): DrawResult {
  if (data.schema_version !== 1 || data.event_id !== command.event_id || typeof data.request_digest !== 'string' ||
      !/^[0-9a-f]{64}$/.test(data.request_digest)) {
    throw new DrawProcessingError('invalid_state', 'Unsupported or malformed deduplication record');
  }
  if (data.request_digest !== command.request_digest) {
    throw new DrawProcessingError('event_id_conflict', 'An event ID was reused for different business content');
  }
  const result = data.result as DrawResult | undefined;
  if (!result || result.schema_version !== 1 || result.event_id !== command.event_id ||
      result.result_id !== `draw-result:${command.event_id}` || result.uid !== command.author.uid ||
      result.source !== command.source || result.occurred_at !== command.occurred_at ||
      result.requested_pixels !== command.pixels.length || !Array.isArray(result.regions) ||
      !Number.isSafeInteger(result.canvas_version) || result.canvas_version < 1 ||
      !Number.isSafeInteger(result.applied_pixels) || result.applied_pixels < 0 ||
      !Number.isSafeInteger(result.ignored_pixels) || result.ignored_pixels < 0 ||
      !['pixel-processed', 'pixel-rejected'].includes(result.type) ||
      data.status !== (result.type === 'pixel-processed' ? 'processed' : 'rejected') ||
      (result.type === 'pixel-processed' && result.applied_pixels + result.ignored_pixels !== result.requested_pixels) ||
      (result.type === 'pixel-rejected' && (result.applied_pixels !== 0 || result.ignored_pixels !== 0 || !result.reason))) {
    throw new DrawProcessingError('invalid_state', 'Malformed persisted draw result');
  }
  return result;
}

export function firestorePixel(metadata: PixelMetadata): PixelMetadata {
  return { ...metadata, eid: Buffer.from(metadata.eid) };
}
