import { describe, expect, it } from 'vitest';
import { decodePng } from '../../../testing/png-reader';
import { PALETTE, emptyTileColors, locatePixel, type Bounds } from '../grid';
import {
  GET_RENDER_OPTIONS,
  RenderTooLargeError,
  SNAPSHOT_RENDER_OPTIONS,
  chooseScale,
  composeArea,
  encodeIndexedPng,
  halveIndexedImage,
  renderAreaPng,
  renderBounds,
  tileSource,
  type CellRange,
  type RasterSource,
} from '.';

const WHITE = '#FFFFFF';
const RED = 6; // #E50000
const BLUE = 14; // #0000EA
const colour = (stored: number) => PALETTE[stored - 1];

// In-memory tile_colors collection, with the ranges each render asked for.
function tileStore() {
  const tiles = new Map<string, { tx: number; ty: number; colors: Uint8Array }>();
  const requests: CellRange[] = [];
  return {
    requests,
    paint(x: number, y: number, color: number) {
      const { tx, ty, index } = locatePixel(x, y);
      const key = `${tx},${ty}`;
      const tile = tiles.get(key) ?? { tx, ty, colors: emptyTileColors() };
      tile.colors[index] = color;
      tiles.set(key, tile);
    },
    source: tileSource(async function* (range) {
      requests.push(range);
      for (const tile of tiles.values()) {
        if (tile.tx >= range.min_cx && tile.tx <= range.max_cx && tile.ty >= range.min_cy && tile.ty <= range.max_cy) yield tile;
      }
    }),
  };
}

const at = (image: { width: number; rgb: string[] }, x: number, y: number) => image.rgb[y * image.width + x];

// Deterministic noise (mulberry32): a PNG that barely compresses.
function noise(length: number, seed = 1): Uint8Array {
  let state = seed;
  return new Uint8Array(length).map(() => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) >>> 28;
  });
}

describe('renderBounds', () => {
  const painted: Bounds = { min_x: -50, min_y: -20, max_x: 30_000, max_y: 40 };

  it('keeps the painted rectangle of an infinite grid', () => {
    expect(renderBounds(painted, null)).toEqual(painted);
  });

  it('clips the painted rectangle to a bounded grid', () => {
    expect(renderBounds(painted, { width: 20_000, height: 10_000 })).toEqual({ min_x: 0, min_y: 0, max_x: 19_999, max_y: 40 });
  });

  it('returns null when nothing is painted inside the grid', () => {
    expect(renderBounds(null, null)).toBeNull();
    expect(renderBounds({ min_x: -9, min_y: -9, max_x: -1, max_y: 5 }, { width: 10_000, height: 10_000 })).toBeNull();
  });

  it('rejects inverted or out-of-range bounds', () => {
    expect(() => renderBounds({ min_x: 5, min_y: 0, max_x: 4, max_y: 0 }, null)).toThrow('minimum');
    expect(() => renderBounds({ min_x: 0, min_y: 0, max_x: 2_000_000_000, max_y: 0 }, null)).toThrow(RangeError);
  });
});

describe('chooseScale', () => {
  it('picks the smallest power of two that fits the longest side', () => {
    expect(chooseScale({ min_x: 0, min_y: 0, max_x: 4095, max_y: 10 }, 4096)).toBe(1);
    expect(chooseScale({ min_x: 0, min_y: 0, max_x: 4096, max_y: 10 }, 4096)).toBe(2);
    expect(chooseScale({ min_x: 0, min_y: -9_999, max_x: 10, max_y: 0 }, 2048)).toBe(8);
  });
});

describe('renderAreaPng', () => {
  it('returns no image when the painted area is empty', async () => {
    const store = tileStore();

    await expect(renderAreaPng(null, null, [store.source], SNAPSHOT_RENDER_OPTIONS)).resolves.toBeNull();
    expect(store.requests).toEqual([]);
  });

  it('renders a small area at full resolution', async () => {
    const store = tileStore();
    store.paint(10, 10, RED);
    store.paint(12, 11, BLUE);

    const rendered = await renderAreaPng({ min_x: 10, min_y: 10, max_x: 12, max_y: 11 }, null, [store.source], SNAPSHOT_RENDER_OPTIONS);

    expect(rendered).toMatchObject({ width: 3, height: 2, scale: 1 });
    const image = decodePng(rendered!.png);
    expect(image.rgb).toEqual([colour(RED), WHITE, WHITE, WHITE, WHITE, colour(BLUE)]);
    expect(store.requests).toEqual([{ min_cx: 0, min_cy: 0, max_cx: 0, max_cy: 0 }]);
  });

  it('renders an area across negative coordinates and tile borders', async () => {
    const store = tileStore();
    store.paint(-65, -1, RED); // tile (-2, -1)
    store.paint(-1, -1, BLUE); // tile (-1, -1)
    store.paint(0, 0, RED); // tile (0, 0)
    store.paint(0, 3, BLUE);
    store.paint(-66, 0, BLUE); // painted, but outside the requested area

    const rendered = await renderAreaPng({ min_x: -65, min_y: -1, max_x: 0, max_y: 3 }, null, [store.source], SNAPSHOT_RENDER_OPTIONS);

    expect(rendered).toMatchObject({ width: 66, height: 5, scale: 1 });
    const image = decodePng(rendered!.png);
    expect(at(image, 0, 0)).toBe(colour(RED));
    expect(at(image, 64, 0)).toBe(colour(BLUE));
    expect(at(image, 65, 1)).toBe(colour(RED));
    expect(at(image, 65, 4)).toBe(colour(BLUE));
    expect(image.rgb.filter((rgb) => rgb !== WHITE)).toHaveLength(4);
    expect(store.requests).toEqual([{ min_cx: -2, min_cy: -1, max_cx: 0, max_cy: 0 }]);
  });

  it('reduces an area larger than the maximum side, keeping isolated pixels', async () => {
    const store = tileStore();
    store.paint(0, 0, RED);
    store.paint(9_999, 9_999, BLUE);
    store.paint(5_001, 5_002, RED);

    const area = { min_x: 0, min_y: 0, max_x: 9_999, max_y: 9_999 };

    const rendered = await renderAreaPng(area, null, [store.source], SNAPSHOT_RENDER_OPTIONS);
    const { image } = await composeArea(area, [store.source], SNAPSHOT_RENDER_OPTIONS);

    expect(rendered).toMatchObject({ width: 2500, height: 2500, scale: 4 });
    // PNG indices: stored colour - 1. Reading them avoids decoding 6 million pixels.
    expect(image.indices[0]).toBe(RED - 1);
    expect(image.indices[1250 * 2500 + 1250]).toBe(RED - 1);
    expect(image.indices[2499 * 2500 + 2499]).toBe(BLUE - 1);
    expect(image.indices.filter((index) => index !== 0)).toHaveLength(3);
  });

  it('halves a noisy image until its PNG fits the upload limit', async () => {
    const store = tileStore();
    const pixels = noise(256 * 256);
    pixels.forEach((index, i) => store.paint(i % 256, Math.floor(i / 256), index + 1));
    const area = { min_x: 0, min_y: 0, max_x: 255, max_y: 255 };
    const maxBytes = 12_000;

    const unbounded = await renderAreaPng(area, null, [store.source], SNAPSHOT_RENDER_OPTIONS);
    const bounded = await renderAreaPng(area, null, [store.source], { ...SNAPSHOT_RENDER_OPTIONS, maxBytes });

    expect(unbounded!.png.byteLength).toBeGreaterThan(maxBytes);
    expect(bounded!.png.byteLength).toBeLessThanOrEqual(maxBytes);
    expect(bounded!.scale).toBeGreaterThan(1);
    expect(bounded!.width).toBe(256 / bounded!.scale);
    expect(decodePng(bounded!.png).width).toBe(bounded!.width);
  });

  it('rejects a byte limit too small to ever be met', async () => {
    const store = tileStore();
    await expect(renderAreaPng(null, null, [store.source], { ...GET_RENDER_OPTIONS, maxBytes: 100 })).rejects.toThrow(RangeError);
  });
});

describe('/get limits', () => {
  it('keeps a worst-case 2048-pixel image under the Discord upload limit', () => {
    const side = GET_RENDER_OPTIONS.maxSide;
    const png = encodeIndexedPng({ width: side, height: side, indices: noise(side * side) });

    // 4-bit pixels: about 2 MiB at most. maxBytes is a safety net if maxSide grows.
    expect(png.byteLength).toBeLessThan(GET_RENDER_OPTIONS.maxBytes!);
  });
});

describe('composeArea', () => {
  const large: Bounds = { min_x: 0, min_y: 0, max_x: 9_999, max_y: 9_999 };

  // A far-view level (DATA-05c): 256×256 cells, 1 image pixel for 4×4 grid pixels.
  function levelOne(cells: { cx: number; cy: number; indices: Uint8Array }[]): RasterSource & { requests: CellRange[] } {
    const requests: CellRange[] = [];
    return {
      scale: 4,
      side: 256,
      requests,
      async *load(range) {
        requests.push(range);
        yield* cells;
      },
    };
  }

  it('reads the coarsest source not coarser than the image', async () => {
    const store = tileStore();
    const indices = new Uint8Array(256 * 256);
    indices[0] = 9;
    const pyramid = levelOne([{ cx: 1, cy: 0, indices }]);

    const { image, scale } = await composeArea(large, [store.source, pyramid], SNAPSHOT_RENDER_OPTIONS);

    expect(scale).toBe(4);
    expect(store.requests).toEqual([]);
    expect(pyramid.requests).toEqual([{ min_cx: 0, min_cy: 0, max_cx: 9, max_cy: 9 }]);
    expect(image.indices[256]).toBe(9); // cell (1, 0) starts at grid x = 1024, image x = 256
  });

  it('keeps reading tiles when the image is at full resolution', async () => {
    const store = tileStore();
    const pyramid = levelOne([]);

    await composeArea({ min_x: 0, min_y: 0, max_x: 99, max_y: 99 }, [store.source, pyramid], SNAPSHOT_RENDER_OPTIONS);

    expect(store.requests).toHaveLength(1);
    expect(pyramid.requests).toEqual([]);
  });

  it('refuses an area that needs more cells than allowed', async () => {
    const store = tileStore();

    const render = composeArea(large, [store.source], { ...SNAPSHOT_RENDER_OPTIONS, maxCells: 1_000 });

    await expect(render).rejects.toBeInstanceOf(RenderTooLargeError);
    await expect(render).rejects.toMatchObject({ cells: 157 * 157, maxCells: 1_000 });
    expect(store.requests).toEqual([]);
  });

  it('rejects unusable sources and malformed cells', async () => {
    const small: Bounds = { min_x: 0, min_y: 0, max_x: 9, max_y: 9 };
    const cell = (cx: number, length: number): RasterSource => ({
      scale: 1, side: 64,
      async *load() { yield { cx, cy: 0, indices: new Uint8Array(length) }; },
    });

    await expect(composeArea(small, [{ ...levelOne([]), scale: 3 }], SNAPSHOT_RENDER_OPTIONS)).rejects.toThrow('power of two');
    await expect(composeArea(small, [levelOne([])], SNAPSHOT_RENDER_OPTIONS)).rejects.toThrow('No source');
    await expect(composeArea(small, [cell(5, 64 * 64)], SNAPSHOT_RENDER_OPTIONS)).rejects.toThrow('outside the requested range');
    await expect(composeArea(small, [cell(0, 10)], SNAPSHOT_RENDER_OPTIONS)).rejects.toThrow('4096 entries');
  });
});

describe('halveIndexedImage', () => {
  it('halves odd sides, a coloured pixel winning over white', () => {
    const halved = halveIndexedImage({ width: 3, height: 3, indices: Uint8Array.of(0, 0, 7, 0, 5, 0, 0, 0, 0) });

    expect(halved).toEqual({ width: 2, height: 2, indices: Uint8Array.of(5, 7, 0, 0) });
  });
});
