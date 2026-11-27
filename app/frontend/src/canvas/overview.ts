import { overviewSpan, type OverviewLevel } from '@pixelwar/shared/overview';
import type { Bounds } from '@pixelwar/shared/grid';
import { visiblePixels, type Camera, type PixelRect, type Viewport } from './camera';

// Far view (WEB-03d): below FAR_ZOOM, the canvas shows the 256×256 images of the pyramid
// (DATA-05c, docs/overview.md) instead of the tiles, and paints the realtime pixels over
// them. The worker rebuilds the changed images every minute; in between, the deltas keep
// the far view live.

/** Below this zoom (CSS pixels per grid pixel), the far view replaces the tiles. */
export const FAR_ZOOM = 1;
// A shown image older than this is asked again: the worker rebuilds the changed images
// every minute. Only when the canvas is redrawn (a move or a delta), never on a timer.
const STALE_MS = 2 * 60_000;
// A failed request is not tried again before this delay.
const RETRY_MS = 10_000;
// A realtime pixel stays over an image asked less than this after it: the worker may not
// have rendered it yet (one cycle a minute, 64 regions at most per cycle).
export const IMAGE_LAG_MS = 3 * 60_000;

/** The coarsest level still fine enough: one image pixel covers at least one CSS pixel. */
export function overviewLevel(zoom: number): OverviewLevel {
  if (zoom >= 1 / 4) return 1;
  if (zoom >= 1 / 16) return 2;
  return 3;
}

/** Inclusive range of the cells of a level that the screen shows. */
export function visibleCells(camera: Camera, viewport: Viewport, level: OverviewLevel): PixelRect {
  const pixels = visiblePixels(camera, viewport);
  const span = overviewSpan(level);
  return {
    min_x: Math.floor(pixels.min_x / span),
    min_y: Math.floor(pixels.min_y / span),
    max_x: Math.floor(pixels.max_x / span),
    max_y: Math.floor(pixels.max_y / span),
  };
}

/** Grid area of a cell. */
export function cellArea(level: OverviewLevel, cx: number, cy: number): Bounds {
  const span = overviewSpan(level);
  return { min_x: cx * span, min_y: cy * span, max_x: (cx + 1) * span - 1, max_y: (cy + 1) * span - 1 };
}

/** Loads one image: null when the area is empty (no object behind the signed URL). */
export type OverviewLoader = (level: OverviewLevel, cx: number, cy: number) => Promise<CanvasImageSource | null>;

interface Cell {
  image: CanvasImageSource | null;
  at: number;
  failed: boolean;
  loading: boolean;
}

export interface OverviewOptions {
  now?: () => number;
  capacity?: number;
}

/** Images of the pyramid by level and cell, in a bounded LRU. */
export class OverviewImages {
  private readonly cells = new Map<string, Cell>();
  private readonly listeners = new Set<(area: Bounds, askedAt: number) => void>();
  private readonly now: () => number;
  private readonly capacity: number;
  private generation = 0;

  constructor(private readonly load: OverviewLoader, options: OverviewOptions = {}) {
    this.now = options.now ?? Date.now;
    this.capacity = options.capacity ?? 160;
  }

  get size(): number {
    return this.cells.size;
  }

  /** Image of a cell: null when the area is empty or not loaded yet (left white). */
  get(level: OverviewLevel, cx: number, cy: number): CanvasImageSource | null {
    return this.cells.get(`${level}/${cx}/${cy}`)?.image ?? null;
  }

  /** Called with the area of each loaded image, and when it was asked. */
  subscribe(listener: (area: Bounds, askedAt: number) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Asks for the visible cells that are missing, stale, or failed long enough ago. */
  show(level: OverviewLevel, cells: PixelRect): void {
    const now = this.now();
    for (let cy = cells.min_y; cy <= cells.max_y; cy += 1) {
      for (let cx = cells.min_x; cx <= cells.max_x; cx += 1) {
        const id = `${level}/${cx}/${cy}`;
        const cell = this.cells.get(id);
        if (cell) {
          // Most recently used last.
          this.cells.delete(id);
          this.cells.set(id, cell);
          if (cell.loading || now - cell.at < (cell.failed ? RETRY_MS : STALE_MS)) continue;
        }
        this.request(level, cx, cy, id, cell);
      }
    }
    for (const id of this.cells.keys()) {
      if (this.cells.size <= this.capacity) break;
      this.cells.delete(id);
    }
  }

  /** A new canvas version: every image is stale. */
  clear(): void {
    this.generation += 1;
    this.cells.clear();
  }

  private request(level: OverviewLevel, cx: number, cy: number, id: string, previous: Cell | undefined): void {
    const at = this.now();
    // The previous image stays shown until the new one is there.
    const cell: Cell = { image: previous?.image ?? null, at, failed: false, loading: true };
    this.cells.set(id, cell);
    const generation = this.generation;
    const current = () => generation === this.generation && this.cells.get(id) === cell;
    this.load(level, cx, cy).then((image) => {
      if (!current()) return;
      Object.assign(cell, { image, loading: false });
      for (const listener of this.listeners) listener(cellArea(level, cx, cy), at);
    }, () => {
      if (current()) Object.assign(cell, { failed: true, loading: false });
    });
  }
}

export interface RecentPixel {
  x: number;
  y: number;
  color: number;
  at: number;
}

/**
 * Realtime pixels painted over the far view, since the images lag behind. A pixel goes
 * away once an image of its area, asked IMAGE_LAG_MS or more after it, is loaded.
 */
export class RecentPixels {
  private readonly pixels = new Map<string, RecentPixel>();

  constructor(private readonly capacity = 100_000) {}

  get size(): number {
    return this.pixels.size;
  }

  add(pixels: ReadonlyArray<{ x: number; y: number; color: number }>, at: number): void {
    for (const { x, y, color } of pixels) {
      const id = `${x},${y}`;
      this.pixels.delete(id);
      this.pixels.set(id, { x, y, color, at });
    }
    for (const id of this.pixels.keys()) {
      if (this.pixels.size <= this.capacity) break;
      this.pixels.delete(id);
    }
  }

  /** An image of this area, asked at askedAt, is loaded: it shows the older pixels. */
  covered(area: Bounds, askedAt: number): void {
    for (const [id, pixel] of this.pixels) {
      if (pixel.at <= askedAt - IMAGE_LAG_MS && pixel.x >= area.min_x && pixel.x <= area.max_x &&
        pixel.y >= area.min_y && pixel.y <= area.max_y) this.pixels.delete(id);
    }
  }

  *inside(rect: PixelRect): Generator<RecentPixel> {
    for (const pixel of this.pixels.values()) {
      if (pixel.x >= rect.min_x && pixel.x <= rect.max_x && pixel.y >= rect.min_y && pixel.y <= rect.max_y) yield pixel;
    }
  }

  clear(): void {
    this.pixels.clear();
  }
}
