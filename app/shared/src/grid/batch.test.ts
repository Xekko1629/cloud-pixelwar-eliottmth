import { describe, expect, it } from 'vitest';
import { TILE_PIXELS } from './constants';
import {
  DOCUMENTS_PER_TOUCHED_TILE,
  assertDocumentBudget,
  assertTileBudget,
  countBatchDocuments,
  emptyTileColors,
  groupPixelsByRegion,
  groupPixelsByTile,
  paintTileColors,
  validateTileColors,
  type DrawPixel,
} from './batch';

const pixel = (x: number, y: number, color = 1): DrawPixel => ({ x, y, color });

describe('groupPixelsByTile', () => {
  it('groups pixels by versioned tile id', () => {
    const groups = groupPixelsByTile([
      pixel(0, 0, 1),
      pixel(63, 63, 16),
      pixel(64, 0, 2),
      pixel(-1, -1, 3),
    ], 1);

    expect([...groups.keys()]).toEqual(['v1_0_0', 'v1_1_0', 'v1_-1_-1']);
    expect(groups.get('v1_0_0')?.pixels).toEqual([pixel(0, 0, 1), pixel(63, 63, 16)]);
    expect(groups.get('v1_1_0')).toMatchObject({ tx: 1, ty: 0, region: '0_0' });
    expect(groups.get('v1_-1_-1')).toMatchObject({ tx: -1, ty: -1, region: '-1_-1' });
  });

  it('assigns a region per tile across the region boundary', () => {
    const groups = groupPixelsByTile([pixel(1_023, 0), pixel(1_024, 0)], 1);
    expect(groups.get('v1_15_0')?.region).toBe('0_0');
    expect(groups.get('v1_16_0')?.region).toBe('1_0');
  });

  it('groups 500 pixels spread over 500 tiles', () => {
    const pixels = Array.from({ length: 500 }, (_, index) => pixel(index * 64, 0));
    const groups = groupPixelsByTile(pixels, 1);
    expect(groups.size).toBe(500);
    for (const group of groups.values()) expect(group.pixels).toHaveLength(1);
  });

  it('rejects duplicate coordinates', () => {
    expect(() => groupPixelsByTile([pixel(1, 2, 1), pixel(1, 2, 2)], 1)).toThrow(/Duplicate/);
  });

  it('rejects invalid pixels and versions', () => {
    expect(() => groupPixelsByTile([pixel(0, 0, 0)], 1)).toThrow(RangeError);
    expect(() => groupPixelsByTile([pixel(0, 0, 17)], 1)).toThrow(RangeError);
    expect(() => groupPixelsByTile([pixel(1_000_000_001, 0)], 1)).toThrow(RangeError);
    expect(() => groupPixelsByTile([pixel(0.5, 0)], 1)).toThrow(RangeError);
    expect(() => groupPixelsByTile([pixel(0, 0)], 0)).toThrow(RangeError);
  });

  it('rejects an empty batch', () => {
    expect(() => groupPixelsByTile([], 1)).toThrow(RangeError);
  });

  it('applies the default and custom pixel caps', () => {
    const pixels = Array.from({ length: 501 }, (_, index) => pixel(index, 0));
    expect(() => groupPixelsByTile(pixels, 1)).toThrow(RangeError);
    expect(() => groupPixelsByTile(pixels, 1, 501)).not.toThrow();
  });

  it('keeps copies instead of caller references', () => {
    const input = pixel(1, 2, 3);
    const group = groupPixelsByTile([input], 1).get('v1_0_0');
    input.color = 16;
    expect(group?.pixels[0].color).toBe(3);
  });
});

describe('groupPixelsByRegion', () => {
  it('groups tiles of the same region and converts to region-local coordinates', () => {
    const groups = groupPixelsByRegion([pixel(0, 0, 1), pixel(1_023, 1_023, 2), pixel(-1, -1, 3)]);
    expect([...groups.keys()]).toEqual(['0_0', '-1_-1']);
    expect(groups.get('0_0')).toEqual({
      rx: 0,
      ry: 0,
      region: '0_0',
      pixels: [pixel(0, 0, 1), pixel(1_023, 1_023, 2)],
    });
    expect(groups.get('-1_-1')?.pixels).toEqual([pixel(1_023, 1_023, 3)]);
  });

  it('splits a batch across the region boundary', () => {
    const groups = groupPixelsByRegion([pixel(1_023, 0, 1), pixel(1_024, 0, 2)]);
    expect(groups.get('0_0')?.pixels).toEqual([pixel(1_023, 0, 1)]);
    expect(groups.get('1_0')?.pixels).toEqual([pixel(0, 0, 2)]);
  });

  it('rejects duplicates, invalid pixels and an empty batch', () => {
    expect(() => groupPixelsByRegion([pixel(1, 2), pixel(1, 2)])).toThrow(/Duplicate/);
    expect(() => groupPixelsByRegion([pixel(0, 0, 0)])).toThrow(RangeError);
    expect(() => groupPixelsByRegion([])).toThrow(RangeError);
    expect(() => groupPixelsByRegion([pixel(0, 0)], 0)).toThrow(RangeError);
    expect(() => groupPixelsByRegion(Array.from({ length: 501 }, (_, index) => pixel(index, 0)))).toThrow(RangeError);
  });
});

describe('paintTileColors', () => {
  it('returns a painted copy without mutating the previous tile', () => {
    const previous = emptyTileColors();
    const next = paintTileColors(previous, 0, 0, [pixel(0, 0, 1), pixel(63, 63, 16)]);

    expect(next).not.toBe(previous);
    expect(next[0]).toBe(1);
    expect(next[TILE_PIXELS - 1]).toBe(16);
    expect(previous.every((colour) => colour === 0)).toBe(true);
  });

  it('handles negative tiles and coordinates', () => {
    const next = paintTileColors(emptyTileColors(), -1, -1, [pixel(-1, -1, 5), pixel(-64, -64, 6)]);
    expect(next[4_095]).toBe(5);
    expect(next[0]).toBe(6);
  });

  it('accepts an empty list as a no-op copy', () => {
    const previous = emptyTileColors();
    const next = paintTileColors(previous, 0, 0, []);
    expect(next).toEqual(previous);
    expect(next).not.toBe(previous);
  });

  it('rejects pixels from another tile and duplicate positions', () => {
    expect(() => paintTileColors(emptyTileColors(), 0, 0, [pixel(64, 0)])).toThrow(/belong/);
    expect(() => paintTileColors(emptyTileColors(), 0, 0, [pixel(-1, 0)])).toThrow(/belong/);
    expect(() => paintTileColors(emptyTileColors(), 0, 0, [pixel(1, 2), pixel(1, 2)])).toThrow(/Duplicate/);
  });

  it('rejects invalid tiles, colours and array lengths', () => {
    expect(() => paintTileColors(emptyTileColors(), 0.5, 0, [])).toThrow(RangeError);
    expect(() => paintTileColors(emptyTileColors(), 0, 0, [pixel(0, 0, 0)])).toThrow(RangeError);
    expect(() => paintTileColors(new Uint8Array(TILE_PIXELS - 1), 0, 0, [])).toThrow(/4096/);
  });
});

describe('assertTileBudget', () => {
  it('accepts a positive count within the budget', () => {
    expect(() => assertTileBudget(1, 1)).not.toThrow();
    expect(() => assertTileBudget(3, 3)).not.toThrow();
  });

  it.each([
    [0, 3],
    [4, 3],
    [1, 0],
    [1.5, 3],
  ])('rejects %i tiles for a budget of %i', (count, budget) => {
    expect(() => assertTileBudget(count, budget)).toThrow(RangeError);
  });
});

describe('document budget', () => {
  it('counts two documents per touched tile plus one delta per region', () => {
    expect(DOCUMENTS_PER_TOUCHED_TILE).toBe(2);
    expect(countBatchDocuments(1, 1)).toBe(3);
    expect(countBatchDocuments(10, 4)).toBe(24);
  });

  it('rejects invalid counts', () => {
    expect(() => countBatchDocuments(0, 1)).toThrow(RangeError);
    expect(() => countBatchDocuments(1, 0)).toThrow(RangeError);
  });

  it('accepts a document count within budget and rejects overflow', () => {
    expect(() => assertDocumentBudget(24, 24)).not.toThrow();
    expect(() => assertDocumentBudget(25, 24)).toThrow(RangeError);
    expect(() => assertDocumentBudget(0, 24)).toThrow(RangeError);
    expect(() => assertDocumentBudget(1, 0)).toThrow(RangeError);
  });
});

describe('tile colours', () => {
  it('creates a dense untouched tile', () => {
    const colours = emptyTileColors();
    expect(colours).toHaveLength(TILE_PIXELS);
    expect(colours.every((colour) => colour === 0)).toBe(true);
  });

  it('accepts untouched and painted palette indexes', () => {
    const colours = emptyTileColors();
    colours[0] = 1;
    colours[TILE_PIXELS - 1] = 16;
    expect(() => validateTileColors(colours)).not.toThrow();
  });

  it('rejects a wrong length', () => {
    expect(() => validateTileColors(new Uint8Array(TILE_PIXELS - 1))).toThrow(/4096/);
    expect(() => validateTileColors(new Uint8Array(TILE_PIXELS + 1))).toThrow(/4096/);
  });

  it('rejects a colour outside the palette', () => {
    const colours = emptyTileColors();
    colours[42] = 17;
    expect(() => validateTileColors(colours)).toThrow(RangeError);
  });
});
