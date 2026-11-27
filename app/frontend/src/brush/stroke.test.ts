import { COORDINATE_LIMIT } from '@pixelwar/shared/grid';
import { describe, expect, it } from 'vitest';
import { Stroke, brushOffsets, linePoints, type BrushShape, type Point } from './stroke';

const keys = (points: Array<{ x: number; y: number }>) => points.map((p) => `${p.x},${p.y}`).sort();
const stroke = (size: number, shape: BrushShape = 'square', extra: Partial<ConstructorParameters<typeof Stroke>[0]> = {}) =>
  new Stroke({ color: 5, size, shape, grid: null, budget: Number.POSITIVE_INFINITY, ...extra });
const drain = (s: Stroke) => {
  const all = [];
  for (let batch = s.take(); batch.length > 0; batch = s.take()) all.push(...batch);
  return all;
};

// Every pixel a stamp at each point of the path would cover: the reference result.
function naive(size: number, shape: BrushShape, path: Point[]): string[] {
  const offsets = brushOffsets(size, shape);
  const set = new Set<string>();
  for (let i = 0; i < path.length; i += 1) {
    const segment = i === 0 ? [path[0]!] : linePoints(path[i - 1]!, path[i]!);
    for (const p of segment) for (const o of offsets) set.add(`${p.x + o.x},${p.y + o.y}`);
  }
  return [...set].sort();
}

describe('brushOffsets', () => {
  it('is one pixel at size 1', () => {
    expect(brushOffsets(1, 'square')).toEqual([{ x: 0, y: 0 }]);
    expect(brushOffsets(1, 'round')).toEqual([{ x: 0, y: 0 }]);
  });

  it('centres an odd size, and puts the extra pixel right and below for an even size', () => {
    expect(keys(brushOffsets(3, 'square'))).toEqual(keys(
      [-1, 0, 1].flatMap((y) => [-1, 0, 1].map((x) => ({ x, y }))),
    ));
    expect(keys(brushOffsets(2, 'square'))).toEqual(keys([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }]));
    expect(brushOffsets(100, 'square')).toHaveLength(10_000);
  });

  it('rounds the corners of the round brush', () => {
    const round = keys(brushOffsets(5, 'round'));
    expect(round).toContain('0,-2');
    expect(round).not.toContain('-2,-2');
    expect(round.length).toBeLessThan(25);
  });

  it('refuses a size out of 1 to 100', () => {
    for (const size of [0, 101, 2.5]) expect(() => brushOffsets(size, 'square')).toThrow(RangeError);
  });
});

describe('linePoints', () => {
  it('joins two points with 8-connected steps', () => {
    const points = linePoints({ x: 0, y: 0 }, { x: 5, y: -2 });
    expect(points[0]).toEqual({ x: 0, y: 0 });
    expect(points.at(-1)).toEqual({ x: 5, y: -2 });
    for (let i = 1; i < points.length; i += 1) {
      expect(Math.max(Math.abs(points[i]!.x - points[i - 1]!.x), Math.abs(points[i]!.y - points[i - 1]!.y))).toBe(1);
    }
  });
});

describe('Stroke', () => {
  it.each([
    [1, 'square'], [2, 'square'], [7, 'square'], [6, 'round'], [9, 'round'],
  ] as const)('covers the same pixels as a stamp at every point, size %i %s', (size, shape) => {
    // A fast stroke: pointer events far apart, in every direction.
    const path = [{ x: 0, y: 0 }, { x: 40, y: 3 }, { x: 12, y: -30 }, { x: -25, y: -25 }, { x: -24, y: 10 }];
    const s = stroke(size, shape);
    for (const point of path) s.moveTo(point);
    expect(keys(drain(s))).toEqual(naive(size, shape, path));
  });

  it('never repeats a pixel, even when the stroke crosses itself', () => {
    const s = stroke(5);
    for (const point of [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 20 }]) s.moveTo(point);
    const pixels = drain(s);
    expect(new Set(keys(pixels)).size).toBe(pixels.length);
    expect(pixels.every((p) => p.color === 5)).toBe(true);
  });

  it('cuts the pixels into batches of 500', () => {
    const s = stroke(30);
    s.moveTo({ x: 0, y: 0 });
    expect(s.count).toBe(900);
    expect(s.take()).toHaveLength(500);
    expect(s.take()).toHaveLength(400);
    expect(s.take()).toHaveLength(0);
  });

  it('stays inside a bounded grid and inside ±10⁹', () => {
    const bounded = stroke(5, 'square', { grid: { width: 10_000, height: 10_000 } });
    bounded.moveTo({ x: 0, y: 9_999 });
    // Offsets -2..2: x below 0 and y from 10 000 on are left out.
    expect(keys(drain(bounded))).toEqual(keys([0, 1, 2].flatMap((x) => [9_997, 9_998, 9_999].map((y) => ({ x, y })))));

    const edge = stroke(3);
    edge.moveTo({ x: COORDINATE_LIMIT, y: 0 });
    expect(drain(edge).every((p) => p.x <= COORDINATE_LIMIT)).toBe(true);
    expect(edge.count).toBe(6);
  });

  it('stops at the budget', () => {
    const s = stroke(10, 'square', { budget: 20 });
    s.moveTo({ x: 0, y: 0 });
    s.moveTo({ x: 30, y: 0 });
    expect(s.count).toBe(20);
    expect(s.exhausted).toBe(true);
  });
});
