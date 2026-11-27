import { TILE_PIXELS, locatePixel, type DrawPixel } from '@pixelwar/shared/grid';
import type { TileKey } from '../canvas/live-tiles';
import type { TileColorsSource } from '../canvas/tiles';
import type { TileChange } from '../realtime/live';

// Local preview of what the user just sent (WEB-05): a separate, half-transparent layer
// drawn over the canvas, never mixed with its tiles. The canvas itself only changes with
// the deltas: it always shows the real state, the preview only marks what is pending.
//
// A preview pixel disappears when the canvas shows its colour (its delta arrived), or
// after `ttlMs` (refused, lost, or drawn over by someone else meanwhile). A refusal is known
// about 3 s after the send (Brush, PixelInspector), so 5 s is enough and keeps it short.

export interface PreviewOptions {
  ttlMs?: number;
  setTimer?: (callback: () => void, ms: number) => unknown;
}

export class PreviewLayer implements TileColorsSource {
  // Per tile: colour of each preview pixel (0 = none) and how many there are.
  private readonly tiles = new Map<string, { colors: Uint8Array; count: number }>();
  private readonly listeners = new Set<(change: TileChange) => void>();
  private readonly ttlMs: number;
  private readonly setTimer: (callback: () => void, ms: number) => unknown;
  private generation = 0;
  private on = true;

  constructor(options: PreviewOptions = {}) {
    this.ttlMs = options.ttlMs ?? 5_000;
    this.setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
  }

  get enabled(): boolean {
    return this.on;
  }

  /** Turned off, the layer stays empty: only the canvas state is shown, nothing pending. */
  setEnabled(enabled: boolean): void {
    this.on = enabled;
    if (!enabled) this.clear();
  }

  get size(): number {
    let total = 0;
    for (const tile of this.tiles.values()) total += tile.count;
    return total;
  }

  get(tx: number, ty: number): Uint8Array | null {
    return this.tiles.get(`${tx},${ty}`)?.colors ?? null;
  }

  /** Tiles that hold preview pixels, to draw the layer without scanning the viewport. */
  keys(): TileKey[] {
    return [...this.tiles.keys()].map((key) => {
      const [tx, ty] = key.split(',').map(Number) as [number, number];
      return { tx, ty };
    });
  }

  subscribe(listener: (change: TileChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Shows the pixels just sent, until their delta arrives or `ttlMs` passes. */
  add(pixels: readonly DrawPixel[]): void {
    if (!this.on || pixels.length === 0) return;
    const touched = new Map<string, TileKey>();
    for (const { x, y, color } of pixels) {
      const { tx, ty, index } = locatePixel(x, y);
      const key = `${tx},${ty}`;
      let tile = this.tiles.get(key);
      if (!tile) {
        tile = { colors: new Uint8Array(TILE_PIXELS), count: 0 };
        this.tiles.set(key, tile);
      }
      if (tile.colors[index] === 0) tile.count += 1;
      tile.colors[index] = color;
      touched.set(key, { tx, ty });
    }
    this.notify([...touched.values()]);
    const generation = this.generation;
    this.setTimer(() => {
      if (generation === this.generation) this.remove(pixels);
    }, this.ttlMs);
  }

  /**
   * The canvas changed: drops the preview pixels it now shows with the same colour. A new
   * canvas version drops the whole preview.
   */
  settle(change: TileChange, canvas: TileColorsSource): void {
    if (change === 'all') return this.clear();
    const touched: TileKey[] = [];
    for (const { tx, ty } of change) {
      const key = `${tx},${ty}`;
      const tile = this.tiles.get(key);
      if (!tile) continue;
      const shown = canvas.get(tx, ty);
      if (!shown) continue;
      let changed = false;
      for (let i = 0; i < TILE_PIXELS; i += 1) {
        if (tile.colors[i] !== 0 && tile.colors[i] === shown[i]) {
          tile.colors[i] = 0;
          tile.count -= 1;
          changed = true;
        }
      }
      if (tile.count === 0) this.tiles.delete(key);
      if (changed) touched.push({ tx, ty });
    }
    if (touched.length > 0) this.notify(touched);
  }

  clear(): void {
    this.generation += 1;
    if (this.tiles.size === 0) return;
    this.tiles.clear();
    this.notify('all');
  }

  /** Takes back these pixels (refused), if they still show the colour sent. */
  forget(pixels: readonly DrawPixel[]): void {
    this.remove(pixels);
  }

  // Expiry: only the pixels still showing the colour this call added.
  private remove(pixels: readonly DrawPixel[]): void {
    const touched = new Map<string, TileKey>();
    for (const { x, y, color } of pixels) {
      const { tx, ty, index } = locatePixel(x, y);
      const key = `${tx},${ty}`;
      const tile = this.tiles.get(key);
      if (!tile || tile.colors[index] !== color) continue;
      tile.colors[index] = 0;
      tile.count -= 1;
      if (tile.count === 0) this.tiles.delete(key);
      touched.set(key, { tx, ty });
    }
    if (touched.size > 0) this.notify([...touched.values()]);
  }

  private notify(change: TileChange): void {
    for (const listener of this.listeners) listener(change);
  }
}
