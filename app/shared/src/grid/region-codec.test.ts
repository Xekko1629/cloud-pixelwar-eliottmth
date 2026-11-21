import { describe, expect, it } from 'vitest';
import { TILE_PIXELS } from './constants';
import {
  REGION_TILES_HEADER_BYTES, REGION_TILE_ENTRY_BYTES, decodeRegionTiles, encodeRegionTiles, type RegionTile,
} from './region-codec';

const tile = (tx: number, ty: number, color = 3): RegionTile => {
  const colors = new Uint8Array(TILE_PIXELS);
  colors[0] = color; colors[TILE_PIXELS - 1] = 16;
  return { tx, ty, colors };
};

describe('region tiles codec', () => {
  it('round-trips the tiles of a negative region, sorted by local row then column', () => {
    const tiles = [tile(-1, -1, 5), tile(-16, -1, 2), tile(-3, -16, 9)];
    const bytes = encodeRegionTiles(7, -1, -1, tiles);
    expect(bytes.byteLength).toBe(REGION_TILES_HEADER_BYTES + 3 * REGION_TILE_ENTRY_BYTES);
    expect([...bytes.subarray(0, REGION_TILES_HEADER_BYTES)]).toEqual([1, 0, 0, 0, 7, 0, 3]);
    const decoded = decodeRegionTiles(bytes, -1, -1);
    expect(decoded.canvas_version).toBe(7);
    expect(decoded.tiles.map(({ tx, ty }) => [tx, ty])).toEqual([[-3, -16], [-16, -1], [-1, -1]]);
    expect(decoded.tiles[2].colors).toEqual(tiles[0].colors);
  });

  it('encodes an empty region as a header only', () => {
    const bytes = encodeRegionTiles(1, 0, 0, []);
    expect([...bytes]).toEqual([1, 0, 0, 0, 1, 0, 0]);
    expect(decodeRegionTiles(bytes, 0, 0)).toEqual({ canvas_version: 1, tiles: [] });
  });

  it('copies decoded colors instead of sharing the network buffer', () => {
    const bytes = encodeRegionTiles(1, 0, 0, [tile(0, 0)]);
    const decoded = decodeRegionTiles(bytes, 0, 0);
    bytes[REGION_TILES_HEADER_BYTES + 2] = 1;
    expect(decoded.tiles[0].colors[0]).toBe(3);
  });

  it.each([
    ['a tile of another region', () => encodeRegionTiles(1, 0, 0, [tile(16, 0)])],
    ['a negative local coordinate', () => encodeRegionTiles(1, 0, 0, [tile(-1, 0)])],
    ['a duplicate tile', () => encodeRegionTiles(1, 0, 0, [tile(1, 1), tile(1, 1)])],
    ['an invalid color', () => encodeRegionTiles(1, 0, 0, [tile(0, 0, 17)])],
    ['a short color array', () => encodeRegionTiles(1, 0, 0, [{ tx: 0, ty: 0, colors: new Uint8Array(10) }])],
    ['a version beyond uint32', () => encodeRegionTiles(2 ** 32, 0, 0, [])],
    ['an invalid region', () => encodeRegionTiles(1, 1e9, 0, [])],
  ])('refuses to encode %s', (_case, action) => {
    expect(action).toThrow();
  });

  it.each([
    ['a truncated header', () => new Uint8Array(6)],
    ['an unknown format', () => { const bytes = encodeRegionTiles(1, 0, 0, []); bytes[0] = 2; return bytes; }],
    ['a zero canvas version', () => new Uint8Array([1, 0, 0, 0, 0, 0, 0])],
    ['a count larger than the payload', () => { const bytes = encodeRegionTiles(1, 0, 0, []); bytes[6] = 1; return bytes; }],
    ['a count beyond a region', () => new Uint8Array([1, 0, 0, 0, 1, 1, 1])],
    ['trailing bytes', () => Uint8Array.from([...encodeRegionTiles(1, 0, 0, []), 0])],
    ['a local coordinate out of region', () => {
      const bytes = encodeRegionTiles(1, 0, 0, [tile(0, 0)]); bytes[REGION_TILES_HEADER_BYTES] = 16; return bytes;
    }],
    ['unsorted tiles', () => {
      const bytes = encodeRegionTiles(1, 0, 0, [tile(0, 0), tile(1, 0)]);
      bytes[REGION_TILES_HEADER_BYTES] = 1; bytes[REGION_TILES_HEADER_BYTES + REGION_TILE_ENTRY_BYTES] = 0; return bytes;
    }],
    ['an invalid color byte', () => {
      const bytes = encodeRegionTiles(1, 0, 0, [tile(0, 0)]); bytes[REGION_TILES_HEADER_BYTES + 2] = 17; return bytes;
    }],
  ])('refuses to decode %s', (_case, make) => {
    expect(() => decodeRegionTiles(make(), 0, 0)).toThrow();
  });

  it('decodes from a view with a non-zero byte offset', () => {
    const encoded = encodeRegionTiles(2, 0, 0, [tile(4, 5)]);
    const padded = new Uint8Array(encoded.byteLength + 3);
    padded.set(encoded, 3);
    expect(decodeRegionTiles(padded.subarray(3), 0, 0).tiles[0]).toMatchObject({ tx: 4, ty: 5 });
  });
});
