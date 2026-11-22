import { describe, expect, it } from 'vitest';
import { TILE_SIDE } from '@pixelwar/shared/grid';
import { GET_RENDER_OPTIONS } from '@pixelwar/shared/render';
import { renderCanvas, type RenderConfig, type RenderStore, type StoredTile } from './render';

function tile(tx: number, ty: number, painted: [number, number, number][]): StoredTile {
  const colors = new Uint8Array(TILE_SIDE * TILE_SIDE);
  for (const [x, y, color] of painted) colors[y * TILE_SIDE + x] = color;
  return { tx, ty, colors };
}
function store(config: RenderConfig, tiles: StoredTile[]): RenderStore & { reads: number[] } {
  const reads: number[] = [];
  return {
    reads,
    async config() { return config; },
    async *tiles(version) { reads.push(version); for (const item of tiles) yield item; },
  };
}
const config = (overrides: Partial<RenderConfig> = {}): RenderConfig =>
  ({ canvas_version: 2, size: null, bounds: { min_x: 0, min_y: 0, max_x: 70, max_y: 3 }, ...overrides });

describe('renderCanvas (/get, DATA-05b)', () => {
  it('renders the painted area of the current canvas version as a PNG', async () => {
    const source = store(config(), [tile(0, 0, [[0, 0, 3]]), tile(1, 0, [[6, 3, 5]])]);
    const result = await renderCanvas(source);
    expect(source.reads).toEqual([2]);
    expect(result.kind).toBe('image');
    if (result.kind !== 'image') return;
    expect(result.canvas_version).toBe(2);
    expect(result.image).toMatchObject({ width: 71, height: 4, scale: 1, area: { min_x: 0, min_y: 0, max_x: 70, max_y: 3 } });
    expect(Array.from(result.image.png.subarray(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  });

  it('answers empty when nothing is painted, without reading tiles', async () => {
    const source = store(config({ bounds: null }), []);
    expect(await renderCanvas(source)).toEqual({ kind: 'empty' });
    expect(source.reads).toEqual([]);
  });

  it('answers empty when the painted area lies outside a reduced grid', async () => {
    const source = store(config({ size: { width: 10_000, height: 10_000 }, bounds: { min_x: 20_000, min_y: 0, max_x: 20_001, max_y: 0 } }), []);
    expect(await renderCanvas(source)).toEqual({ kind: 'empty' });
  });

  it('refuses an area beyond the read budget before reading any tile', async () => {
    const source = store(config({ bounds: { min_x: -1_000_000_000, min_y: 0, max_x: 1_000_000_000, max_y: 0 } }), []);
    const result = await renderCanvas(source, { ...GET_RENDER_OPTIONS, maxCells: 4 });
    expect(result.kind).toBe('too_large');
    expect(source.reads).toEqual([]);
  });

  it('stops reading once the stored tiles exceed the budget (pixels left outside a reduced grid)', async () => {
    // The grid is cut to 10 000 px (157 tiles of 64 px at scale 8); 200 painted tiles lie beyond it.
    const outside = Array.from({ length: 200 }, (_, i) => tile(1000 + i, 0, [[0, 0, 1]]));
    const source = store(config({ size: { width: 10_000, height: 10_000 }, bounds: { min_x: 0, min_y: 0, max_x: 100_000, max_y: 0 } }),
      [tile(0, 0, [[0, 0, 3]]), ...outside]);
    expect((await renderCanvas(source, { ...GET_RENDER_OPTIONS, maxCells: 201 })).kind).toBe('image');
    expect(await renderCanvas(source, { ...GET_RENDER_OPTIONS, maxCells: 160 })).toEqual({ kind: 'too_large', cells: 161 });
  });
});
