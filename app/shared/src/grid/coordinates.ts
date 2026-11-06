import { COORDINATE_LIMIT, REGION_SIDE, TILE_PIXELS, TILE_SIDE, assertCanvasVersion, assertInteger } from './constants';

export interface Point { x: number; y: number }
export interface GridSize { width: number; height: number }
export interface Bounds { min_x: number; min_y: number; max_x: number; max_y: number }

export function locatePixel(x: number, y: number) {
  assertInteger(x, -COORDINATE_LIMIT, COORDINATE_LIMIT, 'x');
  assertInteger(y, -COORDINATE_LIMIT, COORDINATE_LIMIT, 'y');
  const tx = Math.floor(x / TILE_SIDE);
  const ty = Math.floor(y / TILE_SIDE);
  const rx = Math.floor(x / REGION_SIDE);
  const ry = Math.floor(y / REGION_SIDE);
  const localX = x - tx * TILE_SIDE;
  const localY = y - ty * TILE_SIDE;
  return {
    tx, ty, rx, ry,
    localX, localY,
    index: localY * TILE_SIDE + localX,
    regionX: x - rx * REGION_SIDE,
    regionY: y - ry * REGION_SIDE,
  };
}

export function indexToLocal(index: number): Point {
  assertInteger(index, 0, TILE_PIXELS - 1, 'index');
  return { x: index % TILE_SIDE, y: Math.floor(index / TILE_SIDE) };
}

export function assertTileCoordinates(tx: number, ty: number): void {
  const min = Math.floor(-COORDINATE_LIMIT / TILE_SIDE);
  const max = Math.floor(COORDINATE_LIMIT / TILE_SIDE);
  assertInteger(tx, min, max, 'tx');
  assertInteger(ty, min, max, 'ty');
}

export function regionId(rx: number, ry: number): string {
  const min = Math.floor(-COORDINATE_LIMIT / REGION_SIDE);
  const max = Math.floor(COORDINATE_LIMIT / REGION_SIDE);
  assertInteger(rx, min, max, 'rx');
  assertInteger(ry, min, max, 'ry');
  return `${rx}_${ry}`;
}

export function tileRegionId(tx: number, ty: number): string {
  assertTileCoordinates(tx, ty);
  const tilesPerRegion = REGION_SIDE / TILE_SIDE;
  return regionId(Math.floor(tx / tilesPerRegion), Math.floor(ty / tilesPerRegion));
}

export function tileId(version: number, tx: number, ty: number): string {
  assertCanvasVersion(version);
  assertTileCoordinates(tx, ty);
  return `v${version}_${tx}_${ty}`;
}

export function validateGridSize(size: GridSize | null): void {
  if (size === null) return;
  assertInteger(size.width, 10_000, COORDINATE_LIMIT, 'width');
  assertInteger(size.height, 10_000, COORDINATE_LIMIT, 'height');
}

export function isInsideGrid(point: Point, size: GridSize | null): boolean {
  locatePixel(point.x, point.y);
  validateGridSize(size);
  return size === null || (point.x >= 0 && point.y >= 0 && point.x < size.width && point.y < size.height);
}
