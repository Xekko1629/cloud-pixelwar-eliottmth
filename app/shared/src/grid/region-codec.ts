import { REGION_SIDE, TILE_PIXELS, TILE_SIDE, assertCanvasVersion, assertInteger } from './constants';
import { regionId } from './coordinates';
import { validateTileColors } from './batch';

// Transport format of GET /api/regions/{rx}/{ry}/tiles (SRV-11, ADR-0013), browser-safe.
//   header : format uint8 (1) | canvas_version uint32 BE | tile count uint16 BE
//   tile   : local tx uint8 (0..15) | local ty uint8 (0..15) | 4096 color bytes (row-major, 0 = untouched)
// Tiles are sorted by (local ty, local tx); absent tiles are untouched.
export const REGION_TILES_FORMAT = 1;
export const REGION_TILES_HEADER_BYTES = 7;
export const REGION_TILE_ENTRY_BYTES = 2 + TILE_PIXELS;
const TILES_PER_REGION_SIDE = REGION_SIDE / TILE_SIDE;
const MAX_TILES = TILES_PER_REGION_SIDE * TILES_PER_REGION_SIDE;
const MAX_WIRE_VERSION = 0xffff_ffff;

export interface RegionTile { tx: number; ty: number; colors: Uint8Array }
export interface DecodedRegionTiles { canvas_version: number; tiles: RegionTile[] }

function local(tx: number, ty: number, rx: number, ry: number) {
  const lx = tx - rx * TILES_PER_REGION_SIDE;
  const ly = ty - ry * TILES_PER_REGION_SIDE;
  if (!Number.isSafeInteger(lx) || !Number.isSafeInteger(ly) || lx < 0 || ly < 0 ||
      lx >= TILES_PER_REGION_SIDE || ly >= TILES_PER_REGION_SIDE) {
    throw new RangeError('Tile does not belong to the requested region');
  }
  return { lx, ly };
}

export function encodeRegionTiles(canvasVersion: number, rx: number, ry: number, tiles: readonly RegionTile[]): Uint8Array {
  regionId(rx, ry);
  assertCanvasVersion(canvasVersion);
  assertInteger(canvasVersion, 1, MAX_WIRE_VERSION, 'canvas_version');
  assertInteger(tiles.length, 0, MAX_TILES, 'tile count');
  const entries = tiles.map((tile) => ({ ...local(tile.tx, tile.ty, rx, ry), colors: tile.colors }))
    .sort((a, b) => a.ly - b.ly || a.lx - b.lx);
  const bytes = new Uint8Array(REGION_TILES_HEADER_BYTES + entries.length * REGION_TILE_ENTRY_BYTES);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, REGION_TILES_FORMAT);
  view.setUint32(1, canvasVersion);
  view.setUint16(5, entries.length);
  let offset = REGION_TILES_HEADER_BYTES;
  let previous = -1;
  for (const entry of entries) {
    const position = entry.ly * TILES_PER_REGION_SIDE + entry.lx;
    if (position === previous) throw new Error('Duplicate tile in region');
    previous = position;
    validateTileColors(entry.colors);
    bytes[offset] = entry.lx;
    bytes[offset + 1] = entry.ly;
    bytes.set(entry.colors, offset + 2);
    offset += REGION_TILE_ENTRY_BYTES;
  }
  return bytes;
}

/** Strict decoder for the frontend and tests: any malformed byte refuses the whole region. */
export function decodeRegionTiles(bytes: Uint8Array, rx: number, ry: number): DecodedRegionTiles {
  regionId(rx, ry);
  if (bytes.byteLength < REGION_TILES_HEADER_BYTES) throw new Error('Region tiles payload is truncated');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint8(0) !== REGION_TILES_FORMAT) throw new Error('Unknown region tiles format');
  const canvasVersion = view.getUint32(1);
  assertCanvasVersion(canvasVersion);
  const count = view.getUint16(5);
  assertInteger(count, 0, MAX_TILES, 'tile count');
  if (bytes.byteLength !== REGION_TILES_HEADER_BYTES + count * REGION_TILE_ENTRY_BYTES) {
    throw new Error('Region tiles payload length does not match its tile count');
  }
  const tiles: RegionTile[] = [];
  let previous = -1;
  for (let index = 0, offset = REGION_TILES_HEADER_BYTES; index < count; index++, offset += REGION_TILE_ENTRY_BYTES) {
    const lx = bytes[offset];
    const ly = bytes[offset + 1];
    if (lx >= TILES_PER_REGION_SIDE || ly >= TILES_PER_REGION_SIDE) throw new RangeError('Local tile coordinate out of region');
    const position = ly * TILES_PER_REGION_SIDE + lx;
    if (position <= previous) throw new Error('Region tiles must be sorted and unique');
    previous = position;
    // Copy: never let a decoded tile share memory with the network buffer.
    const colors = Uint8Array.from(bytes.subarray(offset + 2, offset + REGION_TILE_ENTRY_BYTES));
    validateTileColors(colors);
    tiles.push({ tx: rx * TILES_PER_REGION_SIDE + lx, ty: ry * TILES_PER_REGION_SIDE + ly, colors });
  }
  return { canvas_version: canvasVersion, tiles };
}
