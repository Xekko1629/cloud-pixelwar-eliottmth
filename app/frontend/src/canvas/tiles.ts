import { COORDINATE_LIMIT, PALETTE, TILE_PIXELS, TILE_SIDE } from '@pixelwar/shared/grid';

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

// Bounded cache of tile images, least recently used first out. WEB-03b adds loading
// from tile-reader and releases the tiles that leave the viewport.
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
}

// Fake data until tile-reader exists (WEB-03a may start without the backend): a pattern
// around the origin, and a marker next to the far corner, to check the rendering at 10⁹.
export const FAR_MARKER = Object.freeze({ x: COORDINATE_LIMIT - 40, y: COORDINATE_LIMIT - 40 });

function fakeColor(x: number, y: number): number {
  // Concentric rings of the 16 colours around the origin, on a 400-pixel disc.
  const distance = Math.hypot(x + 0.5, y + 0.5);
  if (distance < 200) return (Math.floor(distance / 8) % PALETTE.length) + 1;
  // A 32×32 red square framed in black, near (10⁹, 10⁹).
  const dx = x - FAR_MARKER.x;
  const dy = y - FAR_MARKER.y;
  if (dx >= 0 && dy >= 0 && dx < 32 && dy < 32) return dx === 0 || dy === 0 || dx === 31 || dy === 31 ? 4 : 6;
  return 0;
}

export function createFakeTileSource(): TileColorsSource {
  return {
    get(tx, ty) {
      const colors = new Uint8Array(TILE_PIXELS);
      let painted = false;
      for (let i = 0; i < TILE_PIXELS; i += 1) {
        colors[i] = fakeColor(tx * TILE_SIDE + (i % TILE_SIDE), ty * TILE_SIDE + Math.floor(i / TILE_SIDE));
        painted ||= colors[i] !== 0;
      }
      return painted ? colors : null;
    },
  };
}
