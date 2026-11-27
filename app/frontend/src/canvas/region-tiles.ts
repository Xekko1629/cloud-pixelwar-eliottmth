import { REGION_SIDE, TILE_SIDE, type DecodedRegionTiles } from '@pixelwar/shared/grid';
import { visibleRegions } from '../realtime/feed';
import type { TileColorsSource } from './tiles';

// Tiles loaded from tile-reader, one region of 16×16 tiles per request (WEB-03b,
// docs/tile-reader.md). Only the visible regions are requested; past `capacity`, the
// least recently shown region that is no longer visible is released.

export const TILES_PER_REGION_SIDE = REGION_SIDE / TILE_SIDE;

export interface RegionKey {
  rx: number;
  ry: number;
}

/**
 * One request to tile-reader. The browser HTTP cache keeps the answer with its ETag and
 * revalidates it: a region that did not change comes back as a 304, without its body.
 */
export type RegionFetcher = (rx: number, ry: number) => Promise<DecodedRegionTiles>;

// signed-out: no session, the canvas only shows the realtime pixels.
// far: more visible regions than one view may load (WEB-03d shows images instead).
export type TileStatus = 'signed-out' | 'loading' | 'ready' | 'far' | 'error';

export interface RegionEvents {
  /** A request starts: the realtime pixels of the region must be kept until it answers. */
  loading?(region: RegionKey): void;
  /** The region answered: its tiles must be redrawn. */
  loaded?(region: RegionKey): void;
  /** The request failed or was dropped: nothing changed. */
  abandoned?(region: RegionKey): void;
  /** Every region was dropped (sign-out, new canvas version): redraw everything. */
  cleared?(): void;
  status?(status: TileStatus): void;
}

export interface RegionTileOptions {
  // Regions kept in memory. Above MAX_REGIONS_PER_QUERY, so a full view always fits.
  capacity?: number;
  // A failed region is requested again after this delay, if it is still visible.
  retryAfterMs?: number;
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => unknown;
}

interface Entry {
  tiles: Map<string, Uint8Array>;
  loaded: boolean;
  loading: boolean;
  failedAt: number | null;
}

const key = (rx: number, ry: number) => `${rx}_${ry}`;

export function regionOfTile(tx: number, ty: number): RegionKey {
  return { rx: Math.floor(tx / TILES_PER_REGION_SIDE), ry: Math.floor(ty / TILES_PER_REGION_SIDE) };
}

export class RegionTileStore implements TileColorsSource {
  readonly capacity: number;
  private readonly retryAfterMs: number;
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, ms: number) => unknown;
  // Insertion order is the LRU order: a shown region moves to the end.
  private readonly regions = new Map<string, Entry>();
  private fetcher: RegionFetcher | null = null;
  private visible: RegionKey[] | null = [];
  private generation = 0;
  private status: TileStatus | null = null;

  constructor(private readonly events: RegionEvents = {}, options: RegionTileOptions = {}) {
    this.capacity = options.capacity ?? 48;
    this.retryAfterMs = options.retryAfterMs ?? 10_000;
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
    if (!Number.isSafeInteger(this.capacity) || this.capacity < 1) throw new RangeError('capacity must be a positive integer');
    this.setStatus('signed-out');
  }

  get size(): number {
    return this.regions.size;
  }

  get(tx: number, ty: number): Uint8Array | null {
    const { rx, ry } = regionOfTile(tx, ty);
    return this.regions.get(key(rx, ry))?.tiles.get(`${tx},${ty}`) ?? null;
  }

  /** null on sign-out: every region is dropped and nothing is requested any more. */
  setFetcher(fetcher: RegionFetcher | null): void {
    // The session renewal signs in again with the same fetcher: keep the tiles.
    if (fetcher === this.fetcher) return;
    this.fetcher = fetcher;
    this.clear();
  }

  /** New canvas version (/admin clear): the loaded tiles belong to the old one. */
  clear(): void {
    this.generation += 1;
    const had = this.regions.size > 0;
    for (const [id, entry] of this.regions) if (entry.loading) this.events.abandoned?.(parse(id));
    this.regions.clear();
    if (had) this.events.cleared?.();
    this.load();
  }

  /** The canvas shows these pixels: request the missing regions, release the others. */
  // far: the far view shows images (WEB-03d), no region is loaded whatever their number.
  show(rect: { min_x: number; min_y: number; max_x: number; max_y: number }, far = false): void {
    this.visible = far ? null : visibleRegions(rect)?.map(parse) ?? null;
    this.load();
  }

  /**
   * Asks again for every visible region, used after a realtime cut: the deltas of the
   * cut may be gone. A region that did not change costs a 304 (see RegionFetcher).
   */
  revalidate(): void {
    for (const { rx, ry } of this.visible ?? []) {
      const entry = this.regions.get(key(rx, ry));
      if (entry?.loaded && !entry.loading) void this.request(rx, ry, entry);
    }
  }

  private load(): void {
    if (!this.fetcher) return this.setStatus('signed-out');
    if (this.visible === null) return this.setStatus('far');
    const now = this.now();
    for (const { rx, ry } of this.visible) {
      const id = key(rx, ry);
      let entry = this.regions.get(id);
      if (entry) {
        this.regions.delete(id);
        this.regions.set(id, entry);
      } else {
        entry = { tiles: new Map(), loaded: false, loading: false, failedAt: null };
        this.regions.set(id, entry);
      }
      const due = entry.failedAt === null || now - entry.failedAt >= this.retryAfterMs;
      if (!entry.loading && !entry.loaded && due) void this.request(rx, ry, entry);
    }
    this.release();
    this.refreshStatus();
  }

  private release(): void {
    const visible = new Set((this.visible ?? []).map(({ rx, ry }) => key(rx, ry)));
    for (const [id, entry] of this.regions) {
      if (this.regions.size <= this.capacity) break;
      if (visible.has(id)) continue;
      this.regions.delete(id);
      if (entry.loading) this.events.abandoned?.(parse(id));
    }
  }

  private async request(rx: number, ry: number, entry: Entry): Promise<void> {
    const fetcher = this.fetcher;
    if (!fetcher) return;
    const generation = this.generation;
    entry.loading = true;
    this.events.loading?.({ rx, ry });
    let answer: DecodedRegionTiles | null = null;
    try {
      answer = await fetcher(rx, ry);
    } catch {
      answer = null;
    }
    // Dropped meanwhile (sign-out, new version, released): the answer is stale.
    if (generation !== this.generation || this.regions.get(key(rx, ry)) !== entry) return;
    entry.loading = false;
    if (answer === null) {
      this.events.abandoned?.({ rx, ry });
      // A revalidation that fails keeps the tiles already shown.
      if (!entry.loaded) {
        entry.failedAt = this.now();
        this.setTimer(() => {
          if (generation === this.generation) this.load();
        }, this.retryAfterMs);
      }
    } else {
      entry.tiles = new Map(answer.tiles.map((tile) => [`${tile.tx},${tile.ty}`, tile.colors]));
      entry.loaded = true;
      entry.failedAt = null;
      this.events.loaded?.({ rx, ry });
    }
    this.refreshStatus();
  }

  private refreshStatus(): void {
    if (!this.fetcher) return this.setStatus('signed-out');
    if (this.visible === null) return this.setStatus('far');
    const entries = this.visible.map(({ rx, ry }) => this.regions.get(key(rx, ry)));
    if (entries.some((entry) => entry?.failedAt != null && !entry.loading)) return this.setStatus('error');
    this.setStatus(entries.every((entry) => entry?.loaded) ? 'ready' : 'loading');
  }

  private setStatus(status: TileStatus): void {
    if (status === this.status) return;
    this.status = status;
    this.events.status?.(status);
  }
}

function parse(id: string): RegionKey {
  const [rx, ry] = id.split('_').map(Number) as [number, number];
  return { rx, ry };
}
