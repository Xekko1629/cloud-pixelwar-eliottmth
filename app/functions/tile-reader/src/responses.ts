import { createHash } from 'node:crypto';
import {
  REGION_SIDE, TILE_SIDE, assertTileCoordinates, encodeRegionTiles, evaluateRateLimit, regionId,
  type GlobalConfigDocument, type TimestampValue,
} from '@pixelwar/shared/grid';
import { assertOverviewCell, type OverviewLevel } from '@pixelwar/shared/overview';
import type { PixelAuthor, StoredTile, UserReadState } from './store';

export type Route =
  | { kind: 'tiles'; rx: number; ry: number; region: string }
  | { kind: 'meta'; tx: number; ty: number }
  | { kind: 'state' }
  | { kind: 'overview'; level: OverviewLevel; cx: number; cy: number };

export class InvalidRoute extends Error {
  constructor() { super('invalid_coordinates'); this.name = 'InvalidRoute'; }
}

// Canonical decimal integers only: "-0", "+1", "01" or "1e3" are not the same resource.
const INTEGER = '(0|-?[1-9][0-9]{0,9})';
const TILES = new RegExp(`^/api/regions/${INTEGER}/${INTEGER}/tiles$`);
const META = new RegExp(`^/api/tiles/${INTEGER}/${INTEGER}/meta$`);
const OVERVIEW = new RegExp(`^/api/overview/([1-3])/${INTEGER}/${INTEGER}$`);

/** undefined: unknown path (404). InvalidRoute: known path, coordinates out of the grid (400). */
export function parseRoute(path: string): Route | undefined {
  if (path === '/api/state') return { kind: 'state' };
  const tiles = TILES.exec(path);
  if (tiles) {
    const rx = Number(tiles[1]); const ry = Number(tiles[2]);
    try { return { kind: 'tiles', rx, ry, region: regionId(rx, ry) }; } catch { throw new InvalidRoute(); }
  }
  const meta = META.exec(path);
  if (meta) {
    const tx = Number(meta[1]); const ty = Number(meta[2]);
    try { assertTileCoordinates(tx, ty); } catch { throw new InvalidRoute(); }
    return { kind: 'meta', tx, ty };
  }
  const overview = OVERVIEW.exec(path);
  if (overview) {
    const level = Number(overview[1]) as OverviewLevel; const cx = Number(overview[2]); const cy = Number(overview[3]);
    try { assertOverviewCell(level, cx, cy); } catch { throw new InvalidRoute(); }
    return { kind: 'overview', level, cx, cy };
  }
  return undefined;
}

export const iso = (value: TimestampValue) =>
  new Date(value.seconds * 1000 + Math.floor(value.nanoseconds / 1_000_000)).toISOString();

export function regionBody(version: number, route: Extract<Route, { kind: 'tiles' }>, tiles: StoredTile[]): Buffer {
  const bytes = encodeRegionTiles(version, route.rx, route.ry, tiles);
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

export function metaBody(version: number, route: Extract<Route, { kind: 'meta' }>, authors: Record<string, PixelAuthor>): Buffer {
  const pixels = Object.fromEntries(Object.entries(authors)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([index, author]) => [index, { name: author.name, at: iso(author.at) }]));
  return Buffer.from(JSON.stringify({ canvas_version: version, tx: route.tx, ty: route.ty, tile_side: TILE_SIDE, pixels }));
}

/** Same quota rule as DATA-02 (DATA-03): limit, override and minute window are resolved here, not in the browser. */
export function stateBody(config: GlobalConfigDocument, user: UserReadState, nowMs: number): Buffer {
  const quota = evaluateRateLimit({ config, override: user.override, usage: user.usage, now_ms: nowMs, pixel_count: 1 });
  const rejection = user.usage?.last_rejection ?? null;
  return Buffer.from(JSON.stringify({
    canvas_version: config.canvas_version,
    paused: config.paused === true,
    size: config.size ?? null,
    bounds: config.bounds ?? null,
    region_side: REGION_SIDE,
    user: {
      limit_per_minute: quota.limit_per_minute,
      used_pixels: quota.used_before,
      remaining_pixels: Math.max(0, quota.limit_per_minute - quota.used_before),
      reset_at: new Date(quota.reset_at_ms).toISOString(),
      last_rejection: rejection
        ? { event_id: rejection.event_id, reason: rejection.reason, at: iso(rejection.at) }
        : null,
    },
  }));
}

/** Weak validator over the exact uncompressed body: always correct, even for time-dependent quota. */
export function etagOf(body: Buffer): string {
  return `W/"${createHash('sha256').update(body).digest('base64url').slice(0, 27)}"`;
}

export function matchesEtag(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  const opaque = etag.slice(2);
  return header.split(',').map((value) => value.trim()).some((value) =>
    value === '*' || value === etag || value === opaque || value.replace(/^W\//, '') === opaque);
}

export function overviewBody(version: number, route: Extract<Route, { kind: 'overview' }>, signed: { url: string; expires_at: string }): Buffer {
  return Buffer.from(JSON.stringify({ canvas_version: version, level: route.level, cx: route.cx, cy: route.cy, ...signed }));
}
