import { TILE_PIXELS } from '@pixelwar/shared/grid';
import { describe, expect, it, vi } from 'vitest';
import { LiveTileSource } from './live-tiles';
import { TileImageCache, type TileColorsSource } from './tiles';

function base(): TileColorsSource {
  return {
    get: (tx: number, ty: number) => {
      if (tx !== 0 || ty !== 0) return null;
      const colors = new Uint8Array(TILE_PIXELS);
      colors[0] = 7;
      return colors;
    },
  };
}

describe('LiveTileSource', () => {
  it('paints over a copy of the base tile and reports each changed tile once', () => {
    const source = base();
    const live = new LiveTileSource(source);
    expect(live.apply([{ x: 1, y: 0, color: 3 }, { x: 2, y: 0, color: 4 }, { x: -1, y: 64, color: 2 }]))
      .toEqual([{ tx: 0, ty: 0 }, { tx: -1, ty: 1 }]);
    const tile = live.get(0, 0)!;
    expect([tile[0], tile[1], tile[2]]).toEqual([7, 3, 4]);
    expect(source.get(0, 0)![1]).toBe(0);
    expect(live.get(-1, 1)![63]).toBe(2);
    expect(live.size).toBe(2);
  });

  it('keeps the last colour of a pixel painted twice', () => {
    const live = new LiveTileSource(base());
    live.apply([{ x: 5, y: 5, color: 1 }]);
    live.apply([{ x: 5, y: 5, color: 9 }]);
    expect(live.get(0, 0)![5 * 64 + 5]).toBe(9);
  });

  it('gives the least recently changed tile back to the base source past its capacity', () => {
    const live = new LiveTileSource(base(), 2);
    live.apply([{ x: 0, y: 0, color: 1 }]);
    live.apply([{ x: 64, y: 0, color: 1 }]);
    live.apply([{ x: 0, y: 0, color: 2 }]);
    expect(live.apply([{ x: 128, y: 0, color: 1 }])).toEqual([{ tx: 2, ty: 0 }, { tx: 1, ty: 0 }]);
    expect(live.get(1, 0)).toBeNull();
    expect(live.get(0, 0)![0]).toBe(2);
  });

  it('forgets every change on clear', () => {
    const live = new LiveTileSource(base());
    live.apply([{ x: 0, y: 0, color: 1 }]);
    live.clear();
    expect(live.get(0, 0)![0]).toBe(7);
  });

  it('refuses an invalid capacity', () => {
    expect(() => new LiveTileSource(base(), 0)).toThrow(RangeError);
  });
});

describe('TileImageCache invalidation', () => {
  it('rebuilds the image of an invalidated tile, and of every tile after clear', () => {
    const create = vi.fn(() => ({}));
    const cache = new TileImageCache(base(), create);
    cache.get(0, 0);
    cache.get(0, 0);
    expect(create).toHaveBeenCalledTimes(1);
    cache.invalidate(0, 0);
    cache.get(0, 0);
    expect(create).toHaveBeenCalledTimes(2);
    cache.clear();
    expect(cache.size).toBe(0);
  });
});

describe('LiveTileSource.forgetRegion', () => {
  it('goes back to the base tiles of that region only', () => {
    const live = new LiveTileSource(base());
    live.apply([{ x: 0, y: 0, color: 9 }, { x: 1023, y: 1023, color: 9 }, { x: -1, y: 0, color: 9 }]);
    live.forgetRegion(0, 0);
    expect(live.size).toBe(1);
    expect(live.get(-1, 0)?.[63]).toBe(9);
  });
});
