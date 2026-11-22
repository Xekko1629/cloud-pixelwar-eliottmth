import { describe, expect, it } from 'vitest';
import type { Firestore } from '@google-cloud/firestore';
import { TILE_PIXELS } from '@pixelwar/shared/grid';
import { StoredDataError, createFirestoreRenderStore } from './render';

// Minimal in-memory double of the Firestore calls used by the store.
function fakeDb(documents: Record<string, Record<string, unknown> | undefined>) {
  const calls: { where: [string, unknown][]; select: string[] } = { where: [], select: [] };
  const db = {
    doc: (path: string) => ({ get: async () => ({ data: () => documents[path] }) }),
    collection: (collection: string) => {
      const query = {
        where: (field: string, _op: string, value: unknown) => { calls.where.push([field, value]); return query; },
        select: (...fields: string[]) => { calls.select = fields; return query; },
        async *stream() {
          for (const [path, data] of Object.entries(documents)) {
            if (!path.startsWith(`${collection}/`) || !data || !calls.where.every(([field, value]) => data[field] === value)) continue;
            yield { id: path.slice(collection.length + 1), data: () => data };
          }
        },
      };
      return query;
    },
  };
  return { db: db as unknown as Firestore, calls };
}
const colors = (value = 2) => { const bytes = Buffer.alloc(TILE_PIXELS); bytes[0] = value; return bytes; };
const config = { paused: false, canvas_version: 2, size: null, bounds: { min_x: 0, min_y: 0, max_x: 70, max_y: 3 }, default_limit_per_minute: 20 };
const collect = async <T>(items: AsyncIterable<T>) => { const out: T[] = []; for await (const item of items) out.push(item); return out; };

describe('Firestore render store', () => {
  it('reads size and bounds of config/global under an optional root', async () => {
    const { db } = fakeDb({ 'tests/x/config/global': { ...config, size: { width: 20_000, height: 30_000 } } });
    await expect(createFirestoreRenderStore(db, { root: 'tests/x' }).config()).resolves.toEqual({
      canvas_version: 2, size: { width: 20_000, height: 30_000 }, bounds: config.bounds,
    });
  });

  it('accepts an infinite grid with nothing painted', async () => {
    const { db } = fakeDb({ 'config/global': { ...config, bounds: null } });
    await expect(createFirestoreRenderStore(db).config()).resolves.toEqual({ canvas_version: 2, size: null, bounds: null });
  });

  it.each([
    ['missing', undefined],
    ['without a valid version', { ...config, canvas_version: 0 }],
    ['with an invalid size', { ...config, size: { width: 5, height: 5 } }],
    ['with invalid bounds', { ...config, bounds: { min_x: 0, min_y: 0, max_x: 1.5, max_y: 0 } }],
  ])('refuses a %s configuration', async (_case, value) => {
    await expect(createFirestoreRenderStore(fakeDb({ 'config/global': value }).db).config()).rejects.toThrow(StoredDataError);
  });

  it('streams only the tiles of the requested version, with their colours copied', async () => {
    const stored = colors(5);
    const { db, calls } = fakeDb({
      'tile_colors/v2_0_0': { canvas_version: 2, tx: 0, ty: 0, colors: stored },
      'tile_colors/v1_0_0': { canvas_version: 1, tx: 0, ty: 0, colors: colors() },
    });
    const tiles = await collect(createFirestoreRenderStore(db).tiles(2));
    expect(calls.where).toEqual([['canvas_version', 2]]);
    expect(calls.select).toEqual(['tx', 'ty', 'colors']);
    expect(tiles).toHaveLength(1);
    expect(tiles[0]).toMatchObject({ tx: 0, ty: 0 });
    expect(tiles[0].colors[0]).toBe(5);
    expect(tiles[0].colors.buffer).not.toBe(stored.buffer);
  });

  it.each([
    ['a mismatched document id', 'tile_colors/v2_9_9', { canvas_version: 2, tx: 0, ty: 0, colors: colors() }],
    ['non-integer coordinates', 'tile_colors/v2_0_0', { canvas_version: 2, tx: '0', ty: 0, colors: colors() }],
    ['truncated colours', 'tile_colors/v2_0_0', { canvas_version: 2, tx: 0, ty: 0, colors: Buffer.alloc(10) }],
  ])('refuses %s', async (_case, path, data) => {
    await expect(collect(createFirestoreRenderStore(fakeDb({ [path]: data }).db).tiles(2))).rejects.toThrow(StoredDataError);
  });
});
