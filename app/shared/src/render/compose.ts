import { TILE_SIDE, assertInteger } from '../grid/constants';
import { locatePixel, validateGridSize, type Bounds, type GridSize } from '../grid/coordinates';
import { encodeIndexedPng, type IndexedImage } from './png';
import { tileToIndexedImage } from './tile';

// Image of the painted area for /get (BOT-06) and /snapshot (BOT-07a), ADR-0007.
// The grid is infinite: only the painted rectangle is rendered, never the whole grid.

// A square block of PNG indices: cell (cx, cy) of a source covers the grid pixels
// [cx·side·scale, (cx+1)·side·scale) on x, and the same on y. Index 0 is white.
export interface RasterCell {
  cx: number;
  cy: number;
  indices: Uint8Array;
}

export interface CellRange {
  min_cx: number;
  min_cy: number;
  max_cx: number;
  max_cy: number;
}

// Tiles: scale 1, side 64. Far-view pyramid (DATA-05c): scales 4, 16 and 64, side 256.
// load() yields the existing cells of the inclusive range; a missing cell is empty.
export interface RasterSource {
  scale: number;
  side: number;
  load(range: CellRange): AsyncIterable<RasterCell>;
}

export interface RenderOptions {
  // Longest side of the image before encoding; bounds the worker memory (side² bytes).
  maxSide: number;
  // Most cells read from the chosen source; beyond it, a coarser source is required.
  maxCells: number;
  // PNG size limit (Discord upload for /get); the image is halved until it fits.
  maxBytes?: number;
}

// Discord rejects bot attachments above 10 MiB; keep room for the multipart request.
export const DISCORD_UPLOAD_LIMIT_BYTES = 10 * 1024 * 1024;

export const GET_RENDER_OPTIONS: Readonly<RenderOptions> = Object.freeze({
  maxSide: 2048,
  maxCells: 65_536,
  maxBytes: DISCORD_UPLOAD_LIMIT_BYTES - 512 * 1024,
});

// /snapshot is shared through a signed URL: no upload limit.
export const SNAPSHOT_RENDER_OPTIONS: Readonly<RenderOptions> = Object.freeze({
  maxSide: 4096,
  maxCells: 65_536,
});

export interface RenderedArea {
  png: Uint8Array;
  width: number;
  height: number;
  // Grid pixels per image pixel on each side: 1 is full resolution.
  scale: number;
  area: Bounds;
}

export class RenderTooLargeError extends Error {
  constructor(readonly cells: number, readonly maxCells: number) {
    super(`Rendering the area needs ${cells} cells, above the limit of ${maxCells}: a coarser source is required`);
    this.name = 'RenderTooLargeError';
  }
}

// Bounds are inclusive. Intersect the painted rectangle with the grid when it is bounded:
// pixels left outside a reduced grid stay stored but are not rendered (ADR-0007).
export function renderBounds(bounds: Bounds | null, size: GridSize | null): Bounds | null {
  if (bounds === null) return null;
  locatePixel(bounds.min_x, bounds.min_y);
  locatePixel(bounds.max_x, bounds.max_y);
  if (bounds.min_x > bounds.max_x || bounds.min_y > bounds.max_y) throw new Error('Bounds minimum must not exceed maximum');
  validateGridSize(size);
  if (size === null) return { ...bounds };
  const area = {
    min_x: Math.max(bounds.min_x, 0),
    min_y: Math.max(bounds.min_y, 0),
    max_x: Math.min(bounds.max_x, size.width - 1),
    max_y: Math.min(bounds.max_y, size.height - 1),
  };
  return area.min_x > area.max_x || area.min_y > area.max_y ? null : area;
}

// Smallest power of two that fits both sides in maxSide; powers of two stay aligned
// with the 64-pixel tiles and the ×4 pyramid levels.
export function chooseScale(area: Bounds, maxSide: number): number {
  assertInteger(maxSide, 1, 65_536, 'maxSide');
  const longest = Math.max(area.max_x - area.min_x, area.max_y - area.min_y) + 1;
  let scale = 1;
  while (Math.ceil(longest / scale) > maxSide) scale *= 2;
  return scale;
}

export function cellRange(area: Bounds, source: Pick<RasterSource, 'scale' | 'side'>): CellRange {
  const span = source.side * source.scale;
  return {
    min_cx: Math.floor(area.min_x / span),
    min_cy: Math.floor(area.min_y / span),
    max_cx: Math.floor(area.max_x / span),
    max_cy: Math.floor(area.max_y / span),
  };
}

export function countCells(range: CellRange): number {
  return (range.max_cx - range.min_cx + 1) * (range.max_cy - range.min_cy + 1);
}

// The coarsest source that is not coarser than the image: fewest reads (ADR-0007).
function chooseSource(sources: readonly RasterSource[], scale: number): RasterSource {
  const usable = sources.filter((source) => source.scale <= scale && scale % source.scale === 0);
  if (usable.length === 0) throw new Error(`No source can render at scale ${scale}`);
  return usable.reduce((best, source) => (source.scale > best.scale ? source : best));
}

function validateSource(source: RasterSource): void {
  assertInteger(source.scale, 1, 1 << 30, 'source scale');
  if ((source.scale & (source.scale - 1)) !== 0) throw new RangeError('Source scale must be a power of two');
  assertInteger(source.side, 1, 4096, 'source side');
}

// When several source pixels fall in one image pixel, a coloured pixel wins over
// white, so that thin lines survive the reduction; otherwise the last one wins.
function drawCell(image: IndexedImage, area: Bounds, scale: number, source: RasterSource, cell: RasterCell): void {
  const { side } = source;
  if (cell.indices.byteLength !== side * side) throw new Error(`Cell indices must contain ${side * side} entries`);
  const span = side * source.scale;
  const originX = cell.cx * span;
  const originY = cell.cy * span;
  for (let j = 0; j < side; j += 1) {
    const top = originY + j * source.scale;
    if (top + source.scale - 1 < area.min_y || top > area.max_y) continue;
    const row = Math.floor((Math.max(top, area.min_y) - area.min_y) / scale) * image.width;
    for (let i = 0; i < side; i += 1) {
      const index = cell.indices[j * side + i];
      if (index === 0) continue;
      const left = originX + i * source.scale;
      if (left + source.scale - 1 < area.min_x || left > area.max_x) continue;
      image.indices[row + Math.floor((Math.max(left, area.min_x) - area.min_x) / scale)] = index;
    }
  }
}

export async function composeArea(
  area: Bounds,
  sources: readonly RasterSource[],
  options: Pick<RenderOptions, 'maxSide' | 'maxCells'>,
): Promise<{ image: IndexedImage; scale: number }> {
  sources.forEach(validateSource);
  assertInteger(options.maxCells, 1, Number.MAX_SAFE_INTEGER, 'maxCells');
  const scale = chooseScale(area, options.maxSide);
  const source = chooseSource(sources, scale);
  const range = cellRange(area, source);
  const cells = countCells(range);
  if (cells > options.maxCells) throw new RenderTooLargeError(cells, options.maxCells);

  const width = Math.ceil((area.max_x - area.min_x + 1) / scale);
  const height = Math.ceil((area.max_y - area.min_y + 1) / scale);
  const image = { width, height, indices: new Uint8Array(width * height) };
  for await (const cell of source.load(range)) {
    if (cell.cx < range.min_cx || cell.cx > range.max_cx || cell.cy < range.min_cy || cell.cy > range.max_cy) {
      throw new Error('Source returned a cell outside the requested range');
    }
    drawCell(image, area, scale, source, cell);
  }
  return { image, scale };
}

// Halves both sides in memory, with the same colour-over-white rule as drawCell.
export function halveIndexedImage(image: IndexedImage): IndexedImage {
  const width = Math.ceil(image.width / 2);
  const height = Math.ceil(image.height / 2);
  const indices = new Uint8Array(width * height);
  for (let y = 0; y < image.height; y += 1) {
    const row = (y >> 1) * width;
    for (let x = 0; x < image.width; x += 1) {
      const index = image.indices[y * image.width + x];
      if (index !== 0) indices[row + (x >> 1)] = index;
    }
  }
  return { width, height, indices };
}

// Returns null when nothing is painted inside the grid: the caller answers without an image.
export async function renderAreaPng(
  bounds: Bounds | null,
  size: GridSize | null,
  sources: readonly RasterSource[],
  options: RenderOptions,
): Promise<RenderedArea | null> {
  if (options.maxBytes !== undefined) assertInteger(options.maxBytes, 1024, Number.MAX_SAFE_INTEGER, 'maxBytes');
  const area = renderBounds(bounds, size);
  if (area === null) return null;

  let { image, scale } = await composeArea(area, sources, options);
  let png = encodeIndexedPng(image);
  // A 1×1 PNG is far below the 1 KiB minimum of maxBytes: the loop always ends.
  while (options.maxBytes !== undefined && png.byteLength > options.maxBytes) {
    image = halveIndexedImage(image);
    scale *= 2;
    png = encodeIndexedPng(image);
  }
  return { png, width: image.width, height: image.height, scale, area };
}

// Adapts the tile documents of an area (tile_colors, ADR-0007) into a scale-1 source.
// loadTiles yields the existing tiles of the inclusive tile range, in any order.
export function tileSource(
  loadTiles: (range: CellRange) => AsyncIterable<{ tx: number; ty: number; colors: Uint8Array }>,
): RasterSource {
  return {
    scale: 1,
    side: TILE_SIDE,
    async *load(range) {
      for await (const tile of loadTiles(range)) {
        yield { cx: tile.tx, cy: tile.ty, indices: tileToIndexedImage(tile.colors).indices };
      }
    },
  };
}
