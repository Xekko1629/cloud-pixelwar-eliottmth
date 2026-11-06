import { describe, expect, it } from 'vitest';
import {
  assertTileCoordinates,
  indexToLocal,
  isInsideGrid,
  locatePixel,
  regionId,
  tileId,
  tileRegionId,
  validateGridSize,
} from './coordinates';

// The floor division is the core contract: it must round down for negative
// coordinates, not towards zero. These are the values named in the ticket.
describe('locatePixel x axis', () => {
  it.each([
    [0, 0, 0, 0],
    [1, 0, 1, 1],
    [63, 0, 63, 63],
    [64, 1, 0, 0],
    [65, 1, 1, 1],
    [-1, -1, 63, 63],
    [-63, -1, 1, 1],
    [-64, -1, 0, 0],
    [-65, -2, 63, 63],
    [-128, -2, 0, 0],
    [-129, -3, 63, 63],
  ])('x=%i -> tx=%i, localX=%i, index=%i', (x, tx, localX, index) => {
    const located = locatePixel(x, 0);
    expect(located.tx).toBe(tx);
    expect(located.localX).toBe(localX);
    expect(located.index).toBe(index);
  });
});

describe('locatePixel y axis', () => {
  it.each([
    [0, 0, 0, 0],
    [63, 0, 63, 4_032],
    [64, 1, 0, 0],
    [-1, -1, 63, 4_032],
    [-64, -1, 0, 0],
    [-65, -2, 63, 4_032],
  ])('y=%i -> ty=%i, localY=%i, index=%i', (y, ty, localY, index) => {
    const located = locatePixel(0, y);
    expect(located.ty).toBe(ty);
    expect(located.localY).toBe(localY);
    expect(located.index).toBe(index);
  });

  it('combines x and y into a row-major local index', () => {
    expect(locatePixel(-1, -1)).toMatchObject({
      tx: -1,
      ty: -1,
      localX: 63,
      localY: 63,
      index: 4_095,
    });
    expect(locatePixel(1, 2).index).toBe(2 * 64 + 1);
  });
});

describe('locatePixel regions', () => {
  it.each([
    [0, 0, 0, 0],
    [1_023, 0, 1_023, 0],
    [1_024, 1, 0, 1],
    [-1, -1, 1_023, -1],
    [-1_024, -1, 0, -1],
    [-1_025, -2, 1_023, -2],
    [1_000_000_000, 976_562, 512, 976_562],
  ])('x=%i -> rx=%i, regionX=%i', (x, rx, regionX) => {
    expect(locatePixel(x, 0)).toMatchObject({ rx, regionX, regionY: 0 });
  });

  it('applies the same floor division on the y axis', () => {
    expect(locatePixel(0, -1)).toMatchObject({ ry: -1, regionY: 1_023 });
    expect(locatePixel(0, -1_024)).toMatchObject({ ry: -1, regionY: 0 });
    expect(locatePixel(0, 1_000_000_000)).toMatchObject({ ry: 976_562, regionY: 512 });
  });
});

describe('coordinate validation', () => {
  it('accepts the fixed bounds', () => {
    expect(() => locatePixel(-1_000_000_000, 1_000_000_000)).not.toThrow();
    expect(() => locatePixel(1_000_000_000, -1_000_000_000)).not.toThrow();
  });

  it.each([
    [-1_000_000_001, 0],
    [1_000_000_001, 0],
    [0, -1_000_000_001],
    [0, 1_000_000_001],
    [0.5, 0],
    [0, Number.NaN],
  ])('rejects x=%s, y=%s', (x, y) => {
    expect(() => locatePixel(x, y)).toThrow(RangeError);
  });
});

describe('indexToLocal', () => {
  it.each([
    [0, { x: 0, y: 0 }],
    [63, { x: 63, y: 0 }],
    [64, { x: 0, y: 1 }],
    [4_095, { x: 63, y: 63 }],
  ])('index %i maps to %o', (index, point) => {
    expect(indexToLocal(index)).toEqual(point);
  });

  it('round-trips every local index', () => {
    for (let index = 0; index < 4_096; index++) {
      const local = indexToLocal(index);
      expect(locatePixel(local.x, local.y).index).toBe(index);
    }
  });

  it.each([-1, 4_096, 1.5])('rejects %s', (index) => {
    expect(() => indexToLocal(index)).toThrow(RangeError);
  });
});

describe('tile and region identifiers', () => {
  it('names tiles with their canvas version', () => {
    expect(tileId(1, 0, 0)).toBe('v1_0_0');
    expect(tileId(2, -1, -1)).toBe('v2_-1_-1');
  });

  it('accepts tiles covering the fixed bounds', () => {
    expect(() => assertTileCoordinates(-15_625_000, 15_625_000)).not.toThrow();
    expect(() => assertTileCoordinates(15_625_000, -15_625_000)).not.toThrow();
  });

  it('rejects tiles outside the fixed bounds', () => {
    expect(() => assertTileCoordinates(-15_625_001, 0)).toThrow(RangeError);
    expect(() => assertTileCoordinates(0, 15_625_001)).toThrow(RangeError);
  });

  it('formats region identifiers', () => {
    expect(regionId(0, 0)).toBe('0_0');
    expect(regionId(-1, 2)).toBe('-1_2');
  });

  it('maps tiles to their containing region', () => {
    expect(tileRegionId(0, 0)).toBe('0_0');
    expect(tileRegionId(15, 15)).toBe('0_0');
    expect(tileRegionId(16, 16)).toBe('1_1');
    expect(tileRegionId(-1, -1)).toBe('-1_-1');
    expect(tileRegionId(-16, -16)).toBe('-1_-1');
    expect(tileRegionId(-17, -17)).toBe('-2_-2');
  });

  it('rejects regions outside the fixed bounds', () => {
    expect(() => regionId(-976_564, 0)).toThrow(RangeError);
    expect(() => regionId(976_563, 0)).toThrow(RangeError);
  });
});

describe('grid size', () => {
  it('accepts an infinite grid and the documented bounds', () => {
    expect(() => validateGridSize(null)).not.toThrow();
    expect(() => validateGridSize({ width: 10_000, height: 10_000 })).not.toThrow();
    expect(() => validateGridSize({ width: 1_000_000_000, height: 1_000_000_000 })).not.toThrow();
  });

  it.each([
    [{ width: 9_999, height: 10_000 }],
    [{ width: 10_000, height: 9_999 }],
    [{ width: 1_000_000_001, height: 10_000 }],
    [{ width: 10_000.5, height: 10_000 }],
  ])('rejects %o', (size) => {
    expect(() => validateGridSize(size)).toThrow(RangeError);
  });

  it('treats a null size as infinite', () => {
    expect(isInsideGrid({ x: -1, y: -1 }, null)).toBe(true);
    expect(isInsideGrid({ x: 1_000_000_000, y: 1_000_000_000 }, null)).toBe(true);
  });

  it('bounds coordinates when a size is set', () => {
    const size = { width: 10_000, height: 10_000 };
    expect(isInsideGrid({ x: 0, y: 0 }, size)).toBe(true);
    expect(isInsideGrid({ x: 9_999, y: 9_999 }, size)).toBe(true);
    expect(isInsideGrid({ x: 10_000, y: 0 }, size)).toBe(false);
    expect(isInsideGrid({ x: 0, y: 10_000 }, size)).toBe(false);
    expect(isInsideGrid({ x: -1, y: 0 }, size)).toBe(false);
  });

  it('still validates the fixed coordinate bounds', () => {
    expect(() => isInsideGrid({ x: 1_000_000_001, y: 0 }, null)).toThrow(RangeError);
    expect(() => isInsideGrid({ x: 0, y: 0 }, { width: 1, height: 1 })).toThrow(RangeError);
  });
});
