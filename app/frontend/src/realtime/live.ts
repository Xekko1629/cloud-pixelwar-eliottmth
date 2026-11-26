import { locatePixel } from '@pixelwar/shared/grid';
import { LiveTileSource, type TileKey } from '../canvas/live-tiles';
import {
  RegionTileStore, TILES_PER_REGION_SIDE, regionOfTile,
  type RegionFetcher, type RegionKey, type RegionTileOptions, type TileStatus,
} from '../canvas/region-tiles';
import type { TileColorsSource } from '../canvas/tiles';
import {
  RealtimeFeed, type CanvasConfig, type FirestoreBackend, type RealtimeOptions, type RealtimeStatus,
} from './feed';

// Glue between the tiles, the realtime feed and the canvas (WEB-03b, DRAW-03a): the canvas
// reports what it shows, tile-reader loads those regions, the feed follows them, and each
// delta repaints only the tiles it touches.

export type TileChange = readonly TileKey[] | 'all';

/** What PixelCanvas needs from the realtime: tiles to draw, and redraw notifications. */
export interface CanvasUpdates {
  readonly source: TileColorsSource;
  viewportChanged(rect: { min_x: number; min_y: number; max_x: number; max_y: number }): void;
  subscribe(listener: (change: TileChange) => void): () => void;
}

export interface RealtimeState {
  // disabled: no Firestore configuration in this environment (prd before P0-1).
  status: RealtimeStatus | 'disabled';
  config: CanvasConfig | null;
  // Tiles of tile-reader: they need a session (ADR-0015).
  tiles: TileStatus;
}

export class LiveCanvas implements CanvasUpdates {
  private readonly regions: RegionTileStore;
  private readonly tiles: LiveTileSource;
  // Realtime pixels received while their region loads: the answer may predate them.
  private readonly pending = new Map<string, Array<{ x: number; y: number; color: number }>>();
  private readonly tileListeners = new Set<(change: TileChange) => void>();
  private readonly stateListeners = new Set<() => void>();
  private state: RealtimeState;
  private feed: RealtimeFeed | null = null;
  private viewport: { min_x: number; min_y: number; max_x: number; max_y: number } | null = null;
  private started = false;

  constructor(
    // null when the environment has no Firestore configuration.
    private readonly loadBackend: (() => Promise<FirestoreBackend>) | null,
    private readonly options: RealtimeOptions = {},
    regionOptions: RegionTileOptions = {},
  ) {
    this.state = { status: loadBackend ? 'connecting' : 'disabled', config: null, tiles: 'signed-out' };
    this.regions = new RegionTileStore({
      loading: (region) => this.pending.set(regionKey(region), []),
      loaded: (region) => this.regionLoaded(region),
      abandoned: (region) => this.pending.delete(regionKey(region)),
      cleared: () => {
        this.pending.clear();
        this.notify('all');
      },
      status: (tiles) => this.update({ tiles }),
    }, regionOptions);
    this.tiles = new LiveTileSource(this.regions);
  }

  /** Signed in: load the tiles with this fetcher. null on sign-out. */
  setTileFetcher(fetcher: RegionFetcher | null): void {
    this.regions.setFetcher(fetcher);
  }

  get source(): TileColorsSource {
    return this.tiles;
  }

  getState = (): RealtimeState => this.state;

  subscribeState = (listener: () => void): (() => void) => {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  };

  /** Loads the SDK and opens the listeners, once. */
  async start(): Promise<void> {
    if (this.started || !this.loadBackend) return;
    this.started = true;
    let backend: FirestoreBackend;
    try {
      backend = await this.loadBackend();
    } catch {
      this.update({ status: 'error' });
      return;
    }
    this.feed = new RealtimeFeed(backend, {
      config: (config) => this.update({ config }),
      status: (status) => {
        // Back after a cut: deltas older than their TTL are gone, ask tile-reader again.
        const reconnected = this.state.status === 'error' && status === 'live';
        this.update({ status });
        if (reconnected) this.regions.revalidate();
      },
      deltas: (deltas) => {
        const pixels = deltas.flatMap((delta) => delta.pixels);
        for (const pixel of pixels) {
          const { tx, ty } = locatePixel(pixel.x, pixel.y);
          this.pending.get(regionKey(regionOfTile(tx, ty)))?.push(pixel);
        }
        const changed = this.tiles.apply(pixels);
        if (changed.length > 0) this.notify(changed);
      },
      reset: () => {
        this.tiles.clear();
        this.regions.clear();
        this.notify('all');
      },
    }, this.options);
    this.feed.start();
    if (this.viewport) this.feed.setViewport(this.viewport);
  }

  viewportChanged(rect: { min_x: number; min_y: number; max_x: number; max_y: number }): void {
    this.viewport = rect;
    this.regions.show(rect);
    this.feed?.setViewport(rect);
  }

  subscribe(listener: (change: TileChange) => void): () => void {
    this.tileListeners.add(listener);
    return () => this.tileListeners.delete(listener);
  }

  stop(): void {
    this.feed?.stop();
  }

  private regionLoaded(region: RegionKey): void {
    const pixels = this.pending.get(regionKey(region)) ?? [];
    this.pending.delete(regionKey(region));
    // The new tiles hold every pixel drawn before the answer; the pixels received during
    // the request are painted again on top, in order.
    this.tiles.forgetRegion(region.rx, region.ry);
    this.tiles.apply(pixels);
    this.notify(regionTiles(region));
  }

  private notify(change: TileChange): void {
    for (const listener of this.tileListeners) listener(change);
  }

  private update(patch: Partial<RealtimeState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.stateListeners) listener();
  }
}

const regionKey = ({ rx, ry }: RegionKey) => `${rx}_${ry}`;

function regionTiles({ rx, ry }: RegionKey): TileKey[] {
  const tiles: TileKey[] = [];
  for (let y = 0; y < TILES_PER_REGION_SIDE; y += 1) {
    for (let x = 0; x < TILES_PER_REGION_SIDE; x += 1) {
      tiles.push({ tx: rx * TILES_PER_REGION_SIDE + x, ty: ry * TILES_PER_REGION_SIDE + y });
    }
  }
  return tiles;
}
