import {
  COORDINATE_LIMIT, DELTA_ENCODING_VERSION, MAX_REGIONS_PER_QUERY, REGION_SIDE, decodeDelta,
  type Bounds, type GridSize,
} from '@pixelwar/shared/grid';

// Realtime of the canvas (DRAW-03a, ADR-0015): two Firestore listeners, opened by the
// browser with the client library and limited to reads by the Security Rules.
//   - config/global: pause, size, bounds and canvas_version (an /admin clear bumps it);
//   - deltas: changed pixels of the visible regions since the listener opened.
// No polling: the SDK keeps one streaming connection and reconnects by itself.
//
// This file holds the logic only. The Firestore SDK sits behind FirestoreBackend
// (firestore.ts), so that it is loaded on demand and replaced by a fake in tests.

export interface CanvasConfig {
  paused: boolean;
  canvasVersion: number;
  size: GridSize | null;
  bounds: Bounds | null;
}

export interface LivePixel {
  x: number;
  y: number;
  color: number;
}

export interface RegionDelta {
  canvasVersion: number;
  region: string;
  createdAt: number;
  // Absolute grid coordinates.
  pixels: LivePixel[];
}

// Query of ADR-0003: one canvas version, the visible regions (null = every region, far
// view), and only what was written after `since` (ms).
export interface DeltaQuery {
  canvasVersion: number;
  regions: string[] | null;
  since: number;
}

export type Unsubscribe = () => void;

// Raw Firestore data: Timestamp exposes toMillis(), Bytes exposes toUint8Array().
// fromCache: the snapshot comes from the local cache, not the server (connection lost).
export interface FirestoreBackend {
  watchConfig(next: (data: unknown, fromCache?: boolean) => void, error: (error: unknown) => void): Unsubscribe;
  watchDeltas(query: DeltaQuery, added: (documents: unknown[], fromCache?: boolean) => void, error: (error: unknown) => void): Unsubscribe;
}

// offline: network cut, the SDK reconnects by itself; error: a listener was refused.
export type RealtimeStatus = 'connecting' | 'live' | 'offline' | 'error';

export interface RealtimeHandlers {
  config?: (config: CanvasConfig) => void;
  deltas?: (deltas: RegionDelta[]) => void;
  // The canvas version changed (/admin clear): every cached tile is stale.
  reset?: (config: CanvasConfig) => void;
  status?: (status: RealtimeStatus) => void;
}

export interface RealtimeOptions {
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
  // created_at is a server time: the listener starts this far back to absorb clock skew.
  // A delta seen twice paints the same colours again, in the same order.
  clockMargin?: number;
  // The viewport changes every frame while panning: wait for it to settle before
  // recreating the listener.
  debounce?: number;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

const isInteger = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;

function millis(value: unknown): number | null {
  const timestamp = record(value);
  if (timestamp && typeof timestamp.toMillis === 'function') {
    const ms: unknown = (timestamp.toMillis as () => unknown)();
    return typeof ms === 'number' && Number.isFinite(ms) ? ms : null;
  }
  return null;
}

function bytes(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value;
  const blob = record(value);
  if (blob && typeof blob.toUint8Array === 'function') {
    const array: unknown = (blob.toUint8Array as () => unknown)();
    return array instanceof Uint8Array ? array : null;
  }
  return null;
}

function parseSize(value: unknown): GridSize | null {
  const size = record(value);
  return size && isInteger(size.width, 1, COORDINATE_LIMIT) && isInteger(size.height, 1, COORDINATE_LIMIT)
    ? { width: size.width, height: size.height }
    : null;
}

function parseBounds(value: unknown): Bounds | null {
  const bounds = record(value);
  if (!bounds) return null;
  const { min_x: minX, min_y: minY, max_x: maxX, max_y: maxY } = bounds;
  const valid = [minX, minY, maxX, maxY].every((n) => isInteger(n, -COORDINATE_LIMIT, COORDINATE_LIMIT));
  return valid ? { min_x: minX as number, min_y: minY as number, max_x: maxX as number, max_y: maxY as number } : null;
}

/** Reads config/global. null when the document is missing or has no valid version. */
export function parseCanvasConfig(raw: unknown): CanvasConfig | null {
  const data = record(raw);
  if (!data || !isInteger(data.canvas_version, 1, Number.MAX_SAFE_INTEGER)) return null;
  return {
    paused: data.paused === true,
    canvasVersion: data.canvas_version,
    size: parseSize(data.size),
    bounds: parseBounds(data.bounds),
  };
}

const REGION_ID = /^(-?\d+)_(-?\d+)$/;

/** Reads one delta document and converts its pixels to absolute coordinates. */
export function parseDelta(raw: unknown): RegionDelta | null {
  const data = record(raw);
  if (!data || data.encoding_version !== DELTA_ENCODING_VERSION) return null;
  if (!isInteger(data.canvas_version, 1, Number.MAX_SAFE_INTEGER) || typeof data.region !== 'string') return null;
  const match = REGION_ID.exec(data.region);
  const createdAt = millis(data.created_at);
  const encoded = bytes(data.pixels);
  if (!match || createdAt === null || !encoded) return null;
  const rx = Number(match[1]);
  const ry = Number(match[2]);
  try {
    const pixels = decodeDelta(encoded).map((pixel) => ({
      x: rx * REGION_SIDE + pixel.x,
      y: ry * REGION_SIDE + pixel.y,
      color: pixel.color,
    }));
    if (pixels.some((pixel) => Math.abs(pixel.x) > COORDINATE_LIMIT || Math.abs(pixel.y) > COORDINATE_LIMIT)) return null;
    return { canvasVersion: data.canvas_version, region: data.region, createdAt, pixels };
  } catch {
    return null;
  }
}

/**
 * Regions holding the visible pixels (inclusive rectangle), sorted. null when there are
 * more than Firestore accepts in one `in` filter: the listener then follows every region.
 */
export function visibleRegions(rect: { min_x: number; min_y: number; max_x: number; max_y: number }): string[] | null {
  const minX = Math.floor(rect.min_x / REGION_SIDE);
  const maxX = Math.floor(rect.max_x / REGION_SIDE);
  const minY = Math.floor(rect.min_y / REGION_SIDE);
  const maxY = Math.floor(rect.max_y / REGION_SIDE);
  if ((maxX - minX + 1) * (maxY - minY + 1) > MAX_REGIONS_PER_QUERY) return null;
  const regions: string[] = [];
  for (let ry = minY; ry <= maxY; ry += 1) {
    for (let rx = minX; rx <= maxX; rx += 1) regions.push(`${rx}_${ry}`);
  }
  return regions.sort();
}

const regionKey = (regions: string[] | null) => (regions === null ? '*' : regions.join(','));

export class RealtimeFeed {
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, ms: number) => unknown;
  private readonly clearTimer: (timer: unknown) => void;
  private readonly clockMargin: number;
  private readonly debounce: number;
  private config: CanvasConfig | null = null;
  private regions: string[] | null | undefined = undefined;
  private listening: { key: string; version: number; stop: Unsubscribe; token: object } | null = null;
  private stopConfig: Unsubscribe | null = null;
  private timer: unknown = null;
  private status: RealtimeStatus | null = null;

  constructor(
    private readonly backend: FirestoreBackend,
    private readonly handlers: RealtimeHandlers = {},
    options: RealtimeOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
    this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
    this.clockMargin = options.clockMargin ?? 30_000;
    this.debounce = options.debounce ?? 250;
  }

  start(): void {
    if (this.stopConfig) return;
    this.setStatus('connecting');
    this.stopConfig = this.backend.watchConfig((data, fromCache) => this.onConfig(data, fromCache), () => this.setStatus('error'));
  }

  /** Visible pixels of the canvas; the deltas listener follows their regions. */
  setViewport(rect: { min_x: number; min_y: number; max_x: number; max_y: number }): void {
    const regions = visibleRegions(rect);
    if (this.regions !== undefined && regionKey(regions) === regionKey(this.regions)) return;
    this.regions = regions;
    if (this.timer !== null) this.clearTimer(this.timer);
    // The first viewport opens the listener at once; later ones wait for the pan to settle.
    const delay = this.listening ? this.debounce : 0;
    this.timer = this.setTimer(() => {
      this.timer = null;
      this.listen();
    }, delay);
  }

  stop(): void {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    this.stopConfig?.();
    this.stopConfig = null;
    this.listening?.stop();
    this.listening = null;
  }

  private onConfig(data: unknown, fromCache = false): void {
    // From the cache: the connection is lost. The known config stays; the SDK resyncs by
    // itself and the next server snapshot brings the status back to live.
    if (fromCache) { this.setStatus('offline'); return; }
    const config = parseCanvasConfig(data);
    if (!config) { this.setStatus('error'); return; }
    const previous = this.config;
    this.config = config;
    this.setStatus('live');
    this.handlers.config?.(config);
    if (previous && previous.canvasVersion !== config.canvasVersion) this.handlers.reset?.(config);
    this.listen();
  }

  // (Re)creates the deltas listener when the version or the regions changed.
  private listen(): void {
    const config = this.config;
    if (!config || this.regions === undefined) return;
    const key = regionKey(this.regions);
    if (this.listening && this.listening.key === key && this.listening.version === config.canvasVersion) return;
    this.listening?.stop();
    const version = config.canvasVersion;
    const query: DeltaQuery = { canvasVersion: version, regions: this.regions, since: this.now() - this.clockMargin };
    // Identifies this listener: a late snapshot of a replaced one is dropped.
    const token = {};
    const listening = { key, version, token, stop: (() => undefined) as Unsubscribe };
    this.listening = listening;
    listening.stop = this.backend.watchDeltas(query, (documents, fromCache = false) => {
      if (this.listening?.token !== token) return;
      if (!fromCache) this.setStatus('live');
      const deltas = documents.map(parseDelta)
        .filter((delta): delta is RegionDelta => delta !== null && delta.canvasVersion === version)
        .sort((a, b) => a.createdAt - b.createdAt);
      if (deltas.length > 0) this.handlers.deltas?.(deltas);
    }, () => {
      if (this.listening?.token === token) this.setStatus('error');
    });
  }

  private setStatus(status: RealtimeStatus): void {
    if (status === this.status) return;
    this.status = status;
    this.handlers.status?.(status);
  }
}
