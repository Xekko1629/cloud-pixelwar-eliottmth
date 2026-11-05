import { DEFAULT_MAX_BATCH_PIXELS, TILE_PIXELS, assertCanvasVersion, assertColor, assertInteger } from './constants';
import { assertTileCoordinates, locatePixel, regionId, tileId } from './coordinates';
import type { RegionPixel } from './delta-codec';

export interface DrawPixel { x: number; y: number; color: number }
export interface RegionGroup {
  rx: number;
  ry: number;
  region: string;
  pixels: RegionPixel[];
}

export function groupPixelsByTile(pixels: readonly DrawPixel[], version: number, maxPixels = DEFAULT_MAX_BATCH_PIXELS) {
  assertCanvasVersion(version);
  assertInteger(maxPixels, 1, Number.MAX_SAFE_INTEGER, 'maxPixels');
  assertInteger(pixels.length, 1, maxPixels, 'pixel count');
  const tiles = new Map<string, { tx: number; ty: number; region: string; pixels: DrawPixel[] }>();
  const positions = new Set<string>();
  for (const pixel of pixels) {
    const { tx, ty, rx, ry } = locatePixel(pixel.x, pixel.y);
    assertColor(pixel.color);
    const position = `${pixel.x}_${pixel.y}`;
    if (positions.has(position)) throw new Error('Duplicate coordinate in draw batch');
    positions.add(position);
    const id = tileId(version, tx, ty);
    const tile = tiles.get(id) ?? { tx, ty, region: regionId(rx, ry), pixels: [] };
    tile.pixels.push({ ...pixel });
    tiles.set(id, tile);
  }
  return tiles;
}

// Realtime deltas are written once per region and batch (ADR-0003). Coordinates
// are converted to the region-local 0..1023 space used by the delta codec.
export function groupPixelsByRegion(
  pixels: readonly DrawPixel[],
  maxPixels = DEFAULT_MAX_BATCH_PIXELS,
): Map<string, RegionGroup> {
  assertInteger(maxPixels, 1, Number.MAX_SAFE_INTEGER, 'maxPixels');
  assertInteger(pixels.length, 1, maxPixels, 'pixel count');
  const groups = new Map<string, RegionGroup>();
  const positions = new Set<string>();
  for (const pixel of pixels) {
    assertColor(pixel.color);
    const located = locatePixel(pixel.x, pixel.y);
    const position = `${pixel.x}_${pixel.y}`;
    if (positions.has(position)) throw new Error('Duplicate coordinate in draw batch');
    positions.add(position);
    const region = regionId(located.rx, located.ry);
    const group = groups.get(region) ?? { rx: located.rx, ry: located.ry, region, pixels: [] };
    group.pixels.push({ x: located.regionX, y: located.regionY, color: pixel.color });
    groups.set(region, group);
  }
  return groups;
}

// Returns a copy: callers can compare the previous and next tile before writing.
export function paintTileColors(
  colors: Uint8Array,
  tx: number,
  ty: number,
  pixels: readonly DrawPixel[],
): Uint8Array {
  assertTileCoordinates(tx, ty);
  validateTileColors(colors);
  const updated = colors.slice();
  const indexes = new Set<number>();
  for (const pixel of pixels) {
    assertColor(pixel.color);
    const located = locatePixel(pixel.x, pixel.y);
    if (located.tx !== tx || located.ty !== ty) throw new Error('Pixel does not belong to tile');
    if (indexes.has(located.index)) throw new Error('Duplicate coordinate in draw batch');
    indexes.add(located.index);
    updated[located.index] = pixel.color;
  }
  return updated;
}

// Each touched tile writes its colours and metadata documents; each touched
// region writes one delta. Callers can add their own dedupe/config documents.
export const DOCUMENTS_PER_TOUCHED_TILE = 2;

export function countBatchDocuments(tileCount: number, regionCount: number): number {
  assertInteger(tileCount, 1, Number.MAX_SAFE_INTEGER, 'touched tiles');
  assertInteger(regionCount, 1, Number.MAX_SAFE_INTEGER, 'touched regions');
  const count = tileCount * DOCUMENTS_PER_TOUCHED_TILE + regionCount;
  assertInteger(count, 1, Number.MAX_SAFE_INTEGER, 'touched documents');
  return count;
}

export function assertTileBudget(tileCount: number, maxTiles: number): void {
  assertInteger(maxTiles, 1, Number.MAX_SAFE_INTEGER, 'maxTiles');
  assertInteger(tileCount, 1, maxTiles, 'touched tiles');
}

export function assertDocumentBudget(documentCount: number, maxDocuments: number): void {
  assertInteger(maxDocuments, 1, Number.MAX_SAFE_INTEGER, 'maxDocuments');
  assertInteger(documentCount, 1, maxDocuments, 'touched documents');
}

export function emptyTileColors(): Uint8Array {
  return new Uint8Array(TILE_PIXELS);
}

export function validateTileColors(colors: Uint8Array): void {
  if (colors.byteLength !== TILE_PIXELS) throw new Error('Tile colors must contain 4096 bytes');
  for (const color of colors) assertColor(color, true);
}
