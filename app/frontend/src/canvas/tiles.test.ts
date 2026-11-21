import { TILE_PIXELS, TILE_SIDE, locatePixel } from '@pixelwar/shared/grid';
import { describe, expect, it, vi } from 'vitest';
import { FAR_MARKER, TileImageCache, createFakeTileSource, tileRgba, type TileColorsSource } from './tiles';

describe('tileRgba', () => {
  it('paints untouched pixels white and painted ones at their palette colour', () => {
    const colors = new Uint8Array(TILE_PIXELS);
    colors[1] = 6; // #E50000
    colors[2] = 1; // painted white

    const rgba = tileRgba(colors);

    expect(Array.from(rgba.subarray(0, 12))).toEqual([255, 255, 255, 255, 229, 0, 0, 255, 255, 255, 255, 255]);
    expect(rgba.byteLength).toBe(TILE_PIXELS * 4);
  });

  it('rejects a tile of the wrong size', () => {
    expect(() => tileRgba(new Uint8Array(10))).toThrow('4096 bytes');
  });
});

describe('TileImageCache', () => {
  function cache(capacity = 2) {
    const source: TileColorsSource = { get: vi.fn((tx: number) => (tx < 0 ? null : new Uint8Array(TILE_PIXELS))) };
    const createImage = vi.fn((rgba: Uint8ClampedArray) => ({ bytes: rgba.byteLength }));
    return { source, createImage, images: new TileImageCache(source, createImage, capacity) };
  }

  it('creates each image once, and remembers empty tiles', () => {
    const { source, createImage, images } = cache();

    expect(images.get(0, 0)).toEqual({ bytes: TILE_PIXELS * 4 });
    expect(images.get(0, 0)).toBe(images.get(0, 0));
    expect(images.get(-1, 0)).toBeNull();
    images.get(-1, 0);

    expect(createImage).toHaveBeenCalledTimes(1);
    expect(source.get).toHaveBeenCalledTimes(2);
  });

  it('evicts the least recently used tile beyond its capacity', () => {
    const { source, images } = cache(2);
    images.get(0, 0);
    images.get(1, 0);
    images.get(0, 0); // (1, 0) is now the oldest
    images.get(2, 0);

    expect(images.size).toBe(2);
    images.get(0, 0);
    expect(source.get).toHaveBeenCalledTimes(3);
    images.get(1, 0);
    expect(source.get).toHaveBeenCalledTimes(4);
  });

  it('requires a positive capacity', () => {
    const { source, createImage } = cache();
    expect(() => new TileImageCache(source, createImage, 0)).toThrow(RangeError);
  });
});

describe('createFakeTileSource', () => {
  const source = createFakeTileSource();
  const colorAt = (x: number, y: number) => {
    const { tx, ty, index } = locatePixel(x, y);
    return source.get(tx, ty)?.[index] ?? 0;
  };

  it('paints rings around the origin and leaves the rest empty', () => {
    expect(colorAt(0, 0)).toBe(1);
    expect(colorAt(10, 0)).toBe(2);
    expect(colorAt(-150, 0)).not.toBe(0);
    expect(source.get(10, 10)).toBeNull();
  });

  it('paints a framed marker near 10⁹', () => {
    expect(colorAt(FAR_MARKER.x, FAR_MARKER.y)).toBe(4);
    expect(colorAt(FAR_MARKER.x + 5, FAR_MARKER.y + 5)).toBe(6);
    expect(colorAt(FAR_MARKER.x + 32, FAR_MARKER.y)).toBe(0);
    const { tx, ty } = locatePixel(FAR_MARKER.x, FAR_MARKER.y);
    expect(source.get(tx, ty)).toHaveLength(TILE_SIDE * TILE_SIDE);
  });
});
