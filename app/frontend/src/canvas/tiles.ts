import { PALETTE, TILE_PIXELS } from '@pixelwar/shared/grid';

// Stored colours of a tile (ADR-0007): 0 = never painted, 1-16 = palette index.
// null means nothing is painted in the tile.
export interface TileColorsSource {
  get(tx: number, ty: number): Uint8Array | null;
}

const RGB = PALETTE.map((hex) => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)));

// RGBA of a tile for ImageData; untouched pixels are white, like painted white.
export function tileRgba(colors: Uint8Array): Uint8ClampedArray<ArrayBuffer> {
  if (colors.byteLength !== TILE_PIXELS) throw new Error('Tile colors must contain 4096 bytes');
  const rgba = new Uint8ClampedArray(TILE_PIXELS * 4);
  for (let i = 0; i < TILE_PIXELS; i += 1) {
    const [r, g, b] = RGB[Math.max(colors[i] - 1, 0)] ?? RGB[0];
    rgba.set([r, g, b, 255], i * 4);
  }
  return rgba;
}

// Bounded cache of tile images, least recently used first out. The colours come from
// tile-reader (region-tiles.ts) with the realtime pixels over them (live-tiles.ts).
export class TileImageCache<Image> {
  private readonly images = new Map<string, Image | null>();

  constructor(
    private readonly source: TileColorsSource,
    private readonly createImage: (rgba: Uint8ClampedArray<ArrayBuffer>) => Image,
    readonly capacity = 2048,
  ) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new RangeError('capacity must be a positive integer');
  }

  get size(): number {
    return this.images.size;
  }

  get(tx: number, ty: number): Image | null {
    const key = `${tx},${ty}`;
    if (this.images.has(key)) {
      const image = this.images.get(key)!;
      this.images.delete(key);
      this.images.set(key, image);
      return image;
    }
    const colors = this.source.get(tx, ty);
    const image = colors === null ? null : this.createImage(tileRgba(colors));
    this.images.set(key, image);
    if (this.images.size > this.capacity) this.images.delete(this.images.keys().next().value!);
    return image;
  }

  /** Drops the image of a tile whose colours changed: the next get() rebuilds it. */
  invalidate(tx: number, ty: number): void {
    this.images.delete(`${tx},${ty}`);
  }

  clear(): void {
    this.images.clear();
  }
}
