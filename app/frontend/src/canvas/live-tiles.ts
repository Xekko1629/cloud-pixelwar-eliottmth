import { TILE_PIXELS, locatePixel } from '@pixelwar/shared/grid';
import { TILES_PER_REGION_SIDE } from './region-tiles';
import type { TileColorsSource } from './tiles';

export interface TileKey {
  tx: number;
  ty: number;
}

// Tiles of the base source (tile-reader, WEB-03b) with the realtime pixels painted over
// them (DRAW-03a). A changed tile is copied once, then updated in place. When its region
// is loaded again, the copy is dropped: the new tiles already hold those pixels.
//
// Bounded: past `capacity` changed tiles, the least recently changed one goes back to
// the base source.
export class LiveTileSource implements TileColorsSource {
  private readonly changed = new Map<string, Uint8Array>();

  constructor(private readonly base: TileColorsSource, readonly capacity = 4096) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new RangeError('capacity must be a positive integer');
  }

  get size(): number {
    return this.changed.size;
  }

  get(tx: number, ty: number): Uint8Array | null {
    return this.changed.get(`${tx},${ty}`) ?? this.base.get(tx, ty);
  }

  /** Paints the pixels in order and returns the tiles to redraw, once each. */
  apply(pixels: ReadonlyArray<{ x: number; y: number; color: number }>): TileKey[] {
    const touched = new Map<string, TileKey>();
    for (const pixel of pixels) {
      const { tx, ty, index } = locatePixel(pixel.x, pixel.y);
      const key = `${tx},${ty}`;
      let colors = this.changed.get(key);
      if (colors) {
        this.changed.delete(key);
      } else {
        colors = new Uint8Array(this.base.get(tx, ty) ?? new Uint8Array(TILE_PIXELS));
      }
      this.changed.set(key, colors);
      colors[index] = pixel.color;
      touched.set(key, { tx, ty });
    }
    while (this.changed.size > this.capacity) {
      const oldest = this.changed.keys().next().value!;
      this.changed.delete(oldest);
      const [tx, ty] = oldest.split(',').map(Number) as [number, number];
      touched.set(oldest, { tx, ty });
    }
    return [...touched.values()];
  }

  /** Forgets the realtime pixels of a region: tile-reader just answered with newer tiles. */
  forgetRegion(rx: number, ry: number): void {
    for (const key of [...this.changed.keys()]) {
      const [tx, ty] = key.split(',').map(Number) as [number, number];
      if (Math.floor(tx / TILES_PER_REGION_SIDE) === rx && Math.floor(ty / TILES_PER_REGION_SIDE) === ry) this.changed.delete(key);
    }
  }

  /** Forgets every realtime pixel (new canvas version after /admin clear). */
  clear(): void {
    this.changed.clear();
  }
}
