import { COORDINATE_LIMIT, DEFAULT_MAX_BATCH_PIXELS, isInsideGrid, type DrawPixel, type GridSize } from '@pixelwar/shared/grid';

// Pixels covered by a brush stroke (WEB-05). Pure: no DOM, no network.
//
// The brush is stamped at every grid point of the pointer path (Bresenham between two
// pointer events), so a fast stroke has no hole. Between two neighbour points the stamp
// only adds its leading edge, computed once per direction: a size-100 brush adds about
// 100 pixels per step instead of 10 000. Each pixel is kept once per stroke, so a request
// never holds the same coordinate twice (web-proxy refuses it, 400 duplicate_pixel).

export const MIN_BRUSH_SIZE = 1;
export const MAX_BRUSH_SIZE = 100;
export type BrushShape = 'square' | 'round';

export interface Point {
  x: number;
  y: number;
}

/**
 * Offsets of the stamp around the pointer pixel. The stamp spans `size` pixels from
 * -floor((size - 1) / 2): an odd size is centred, an even size has one more pixel to the
 * right and below. Round: pixels whose centre lies in the disc inscribed in the square.
 */
export function brushOffsets(size: number, shape: BrushShape): Point[] {
  if (!Number.isInteger(size) || size < MIN_BRUSH_SIZE || size > MAX_BRUSH_SIZE) {
    throw new RangeError(`brush size must be ${MIN_BRUSH_SIZE} to ${MAX_BRUSH_SIZE}`);
  }
  // 0 - … rather than -…: no -0 offset at size 1 or 2.
  const start = 0 - Math.floor((size - 1) / 2);
  const centre = start + size / 2;
  const radius = size / 2;
  const offsets: Point[] = [];
  for (let dy = start; dy < start + size; dy += 1) {
    for (let dx = start; dx < start + size; dx += 1) {
      if (shape === 'round' && Math.hypot(dx + 0.5 - centre, dy + 0.5 - centre) > radius) continue;
      offsets.push({ x: dx, y: dy });
    }
  }
  return offsets;
}

/** Grid points from a to b included, 8-connected (Bresenham). */
export function linePoints(a: Point, b: Point): Point[] {
  const points: Point[] = [];
  const dx = Math.abs(b.x - a.x);
  const dy = -Math.abs(b.y - a.y);
  const sx = a.x < b.x ? 1 : -1;
  const sy = a.y < b.y ? 1 : -1;
  let error = dx + dy;
  let { x, y } = a;
  for (;;) {
    points.push({ x, y });
    if (x === b.x && y === b.y) return points;
    const twice = 2 * error;
    if (twice >= dy) { error += dy; x += sx; }
    if (twice <= dx) { error += dx; y += sy; }
  }
}

export interface StrokeOptions {
  color: number;
  size: number;
  shape: BrushShape;
  // Bounded grid (config/global.size), null when infinite.
  grid: GridSize | null;
  // Pixels this stroke may still add: the quota known by the client. The server decides
  // anyway; this only avoids sending pixels that would surely be refused.
  budget: number;
}

export class Stroke {
  private readonly offsets: Point[];
  private readonly leading = new Map<string, Point[]>();
  private readonly seen = new Set<string>();
  private readonly queue: DrawPixel[] = [];
  private last: Point | null = null;
  private added = 0;
  // True once the budget stopped the stroke.
  exhausted = false;

  constructor(private readonly options: StrokeOptions) {
    this.offsets = brushOffsets(options.size, options.shape);
  }

  /** Pixels of the stroke so far. */
  get count(): number {
    return this.added;
  }

  /** Pixels waiting to be sent. */
  get pending(): number {
    return this.queue.length;
  }

  /** Extends the stroke to this grid point and returns how many new pixels it covers. */
  moveTo(point: Point): number {
    const before = this.added;
    if (this.last === null) {
      this.stamp(point, this.offsets);
    } else {
      const path = linePoints(this.last, point);
      for (let i = 1; i < path.length; i += 1) {
        const step = path[i]!;
        const previous = path[i - 1]!;
        this.stamp(step, this.leadingEdge(step.x - previous.x, step.y - previous.y));
      }
    }
    this.last = point;
    return this.added - before;
  }

  /** Up to `max` pixels to send now, in the order they were covered. */
  take(max = DEFAULT_MAX_BATCH_PIXELS): DrawPixel[] {
    return this.queue.splice(0, max);
  }

  private stamp(at: Point, offsets: readonly Point[]): void {
    for (const offset of offsets) {
      if (this.added >= this.options.budget) {
        this.exhausted = true;
        return;
      }
      const x = at.x + offset.x;
      const y = at.y + offset.y;
      if (Math.abs(x) > COORDINATE_LIMIT || Math.abs(y) > COORDINATE_LIMIT) continue;
      if (this.options.grid && !isInsideGrid({ x, y }, this.options.grid)) continue;
      const key = `${x},${y}`;
      if (this.seen.has(key)) continue;
      this.seen.add(key);
      this.queue.push({ x, y, color: this.options.color });
      this.added += 1;
    }
  }

  // Offsets of the stamp not covered by the stamp one step back: what a move adds.
  private leadingEdge(sx: number, sy: number): Point[] {
    const key = `${sx},${sy}`;
    let edge = this.leading.get(key);
    if (!edge) {
      const covered = new Set(this.offsets.map((o) => `${o.x},${o.y}`));
      edge = this.offsets.filter((o) => !covered.has(`${o.x + sx},${o.y + sy}`));
      this.leading.set(key, edge);
    }
    return edge;
  }
}
