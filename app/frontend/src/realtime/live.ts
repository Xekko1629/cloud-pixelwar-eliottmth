import { LiveTileSource, type TileKey } from '../canvas/live-tiles';
import type { TileColorsSource } from '../canvas/tiles';
import {
  RealtimeFeed, type CanvasConfig, type FirestoreBackend, type RealtimeOptions, type RealtimeStatus,
} from './feed';

// Glue between the realtime feed and the canvas (DRAW-03a): the canvas reports what it
// shows, the feed follows those regions, and each delta repaints only the tiles it touches.

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
}

export class LiveCanvas implements CanvasUpdates {
  private readonly tiles: LiveTileSource;
  private readonly tileListeners = new Set<(change: TileChange) => void>();
  private readonly stateListeners = new Set<() => void>();
  private state: RealtimeState;
  private feed: RealtimeFeed | null = null;
  private viewport: { min_x: number; min_y: number; max_x: number; max_y: number } | null = null;
  private started = false;

  constructor(
    base: TileColorsSource,
    // null when the environment has no Firestore configuration.
    private readonly loadBackend: (() => Promise<FirestoreBackend>) | null,
    private readonly options: RealtimeOptions = {},
  ) {
    this.tiles = new LiveTileSource(base);
    this.state = { status: loadBackend ? 'connecting' : 'disabled', config: null };
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
      status: (status) => this.update({ status }),
      deltas: (deltas) => {
        const changed = this.tiles.apply(deltas.flatMap((delta) => delta.pixels));
        if (changed.length > 0) this.notify(changed);
      },
      reset: () => {
        this.tiles.clear();
        this.notify('all');
      },
    }, this.options);
    this.feed.start();
    if (this.viewport) this.feed.setViewport(this.viewport);
  }

  viewportChanged(rect: { min_x: number; min_y: number; max_x: number; max_y: number }): void {
    this.viewport = rect;
    this.feed?.setViewport(rect);
  }

  subscribe(listener: (change: TileChange) => void): () => void {
    this.tileListeners.add(listener);
    return () => this.tileListeners.delete(listener);
  }

  stop(): void {
    this.feed?.stop();
  }

  private notify(change: TileChange): void {
    for (const listener of this.tileListeners) listener(change);
  }

  private update(patch: Partial<RealtimeState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.stateListeners) listener();
  }
}
