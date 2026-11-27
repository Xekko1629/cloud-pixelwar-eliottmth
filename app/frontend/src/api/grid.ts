import { DEFAULT_MAX_BATCH_PIXELS, PALETTE, TILE_PIXELS, type DrawPixel } from '@pixelwar/shared/grid';
import type { ApiClient } from './client';

// Grid calls of the frontend through the gateway, with the session (WEB-04):
//   GET  /api/tiles/{tx}/{ty}/meta  author and date of each pixel (docs/tile-reader.md)
//   GET  /api/state                 quota and last refusal of the caller
//   POST /api/pixels                draw, one pixel-draw event per pixel (docs/web-proxy.md)
// Every answer is validated: a malformed one throws instead of showing wrong data.

export interface PixelAuthor {
  name: string;
  at: Date;
}

export interface TileMeta {
  canvasVersion: number;
  tx: number;
  ty: number;
  // Index y × 64 + x in the tile; a pixel never painted is absent.
  pixels: Map<number, PixelAuthor>;
}

export interface UserQuota {
  limitPerMinute: number;
  usedPixels: number;
  remainingPixels: number;
  resetAt: Date;
  lastRejection: { eventId: string; reason: string; at: Date } | null;
}

export interface DrawAccepted {
  correlationId: string;
  /** The FIRST eventIds.length pixels of the request were accepted (ADR-0017). */
  eventIds: string[];
  /** The other pixels: refused before publication, never drawn. */
  refused?: { count: number; reason: string; retryAfterSeconds: number | null };
}

const record = (value: unknown): Record<string, unknown> | null =>
  (typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null);
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const date = (value: unknown): Date | null => {
  if (typeof value !== 'string') return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
};

function invalid(what: string): never {
  throw new Error(`Invalid ${what} answer`);
}

export async function fetchTileMeta(api: ApiClient, tx: number, ty: number): Promise<TileMeta> {
  const body = record(await api.json(`/api/tiles/${tx}/${ty}/meta`));
  const pixels = record(body?.pixels);
  if (!body || !pixels || body.tx !== tx || body.ty !== ty || !count(body.canvas_version)) invalid('tile meta');
  const authors = new Map<number, PixelAuthor>();
  for (const [key, value] of Object.entries(pixels)) {
    const index = Number(key);
    const pixel = record(value);
    const at = date(pixel?.at);
    if (!/^(0|[1-9][0-9]*)$/.test(key) || index >= TILE_PIXELS || typeof pixel?.name !== 'string' || !at) invalid('tile meta');
    authors.set(index, { name: pixel.name, at });
  }
  return { canvasVersion: body.canvas_version, tx, ty, pixels: authors };
}

export async function fetchUserQuota(api: ApiClient): Promise<UserQuota> {
  const user = record(record(await api.json('/api/state'))?.user);
  const resetAt = date(user?.reset_at);
  if (!user || !count(user.limit_per_minute) || !count(user.used_pixels) || !count(user.remaining_pixels) || !resetAt) {
    invalid('state');
  }
  let lastRejection: UserQuota['lastRejection'] = null;
  if (user.last_rejection !== null) {
    const rejection = record(user.last_rejection);
    const at = date(rejection?.at);
    if (!rejection || typeof rejection.event_id !== 'string' || typeof rejection.reason !== 'string' || !at) invalid('state');
    lastRejection = { eventId: rejection.event_id, reason: rejection.reason, at };
  }
  return {
    limitPerMinute: user.limit_per_minute,
    usedPixels: user.used_pixels,
    remainingPixels: user.remaining_pixels,
    resetAt,
    lastRejection,
  };
}

/** Publishes the pixels (1 to 500, distinct coordinates). 202 means accepted, not drawn. */
export async function postPixels(api: ApiClient, pixels: readonly DrawPixel[]): Promise<DrawAccepted> {
  if (pixels.length === 0 || pixels.length > DEFAULT_MAX_BATCH_PIXELS) throw new RangeError('1 to 500 pixels per request');
  for (const { color } of pixels) {
    if (!Number.isInteger(color) || color < 1 || color > PALETTE.length) throw new RangeError('color must be 1 to 16');
  }
  const body = record(await api.json('/api/pixels', { pixels }));
  const eventIds = body?.event_ids;
  if (!body || typeof body.correlation_id !== 'string' || !Array.isArray(eventIds) || eventIds.length < 1 ||
      eventIds.length > pixels.length || !eventIds.every((id) => typeof id === 'string')) {
    invalid('draw');
  }
  // Fewer ids than pixels only with the explanation of the refused ones, and the other way round.
  const refused = record(body.refused);
  if ((eventIds.length < pixels.length) !== (refused !== null) || (refused &&
      (refused.count !== pixels.length - eventIds.length || typeof refused.reason !== 'string' ||
       !(refused.retry_after_seconds === null || count(refused.retry_after_seconds))))) {
    invalid('draw');
  }
  return {
    correlationId: body.correlation_id, eventIds: eventIds as string[],
    ...(refused ? { refused: { count: refused.count as number, reason: refused.reason as string, retryAfterSeconds: refused.retry_after_seconds as number | null } } : {}),
  };
}

export interface OverviewUrl {
  canvasVersion: number;
  url: string;
  expiresAt: Date;
}

/** Signed URL of one far-view image (WEB-03d, docs/overview.md), valid 15 minutes. */
export async function fetchOverviewUrl(api: ApiClient, level: number, cx: number, cy: number): Promise<OverviewUrl> {
  const body = record(await api.json(`/api/overview/${level}/${cx}/${cy}`));
  const expiresAt = date(body?.expires_at);
  if (!body || body.level !== level || body.cx !== cx || body.cy !== cy || !count(body.canvas_version) ||
      typeof body.url !== 'string' || !body.url.startsWith('https://') || !expiresAt) {
    invalid('overview');
  }
  return { canvasVersion: body.canvas_version, url: body.url, expiresAt };
}
