import { describe, expect, it, vi } from 'vitest';
import type { Firestore } from '@google-cloud/firestore';
import { TILE_PIXELS } from '@pixelwar/shared/grid';
import { StoredDataError, createFirestoreTileStore } from './store';

// Minimal in-memory double of the Firestore calls used by the store; the emulator test covers the real SDK.
function fakeDb(documents: Record<string, Record<string, unknown> | undefined>) {
  const where = vi.fn();
  const doc = (path: string) => ({ path, get: async () => ({ data: () => documents[path] }) });
  const db = {
    doc,
    getAll: async (...refs: { path: string }[]) => refs.map((ref) => ({ data: () => documents[ref.path] })),
    collection: (collection: string) => {
      const filters: [string, unknown][] = [];
      const query = {
        where: (field: string, _op: string, value: unknown) => { where(field, value); filters.push([field, value]); return query; },
        get: async () => ({
          docs: Object.entries(documents)
            .filter(([path, data]) => path.startsWith(`${collection}/`) && data && filters.every(([field, value]) => data[field] === value))
            .map(([path, data]) => ({ id: path.slice(collection.length + 1), data: () => data })),
        }),
      };
      return query;
    },
  };
  return { db: db as unknown as Firestore, where };
}
const colors = (value = 2) => { const bytes = Buffer.alloc(TILE_PIXELS); bytes[0] = value; return bytes; };
const at = { seconds: 1_763_632_800, nanoseconds: 0 };
const config = { paused: false, canvas_version: 2, size: null, bounds: null, default_limit_per_minute: 20 };

describe('Firestore tile store', () => {
  it('reads the configuration under an optional root', async () => {
    const { db } = fakeDb({ 'tests/x/config/global': config });
    await expect(createFirestoreTileStore(db, { root: 'tests/x' }).config()).resolves.toEqual(config);
  });

  it.each([['missing', undefined], ['without a valid version', { ...config, canvas_version: 0 }]])(
    'refuses a %s configuration', async (_case, value) => {
      await expect(createFirestoreTileStore(fakeDb({ 'config/global': value }).db).config()).rejects.toThrow(StoredDataError);
    });

  it('queries the tiles of one region and version, and copies their colors', async () => {
    const source = colors(7);
    const { db, where } = fakeDb({
      'tile_colors/v2_1_0': { canvas_version: 2, region: '0_0', tx: 1, ty: 0, colors: source, updated_at: at },
      'tile_colors/v1_1_0': { canvas_version: 1, region: '0_0', tx: 1, ty: 0, colors: colors(), updated_at: at },
      'tile_colors/v2_16_0': { canvas_version: 2, region: '1_0', tx: 16, ty: 0, colors: colors(), updated_at: at },
    });
    const tiles = await createFirestoreTileStore(db).regionTiles(2, '0_0');
    expect(where.mock.calls).toEqual([['canvas_version', 2], ['region', '0_0']]);
    expect(tiles).toHaveLength(1);
    expect(tiles[0]).toMatchObject({ tx: 1, ty: 0 });
    source[0] = 9;
    expect(tiles[0].colors[0]).toBe(7);
  });

  it.each([
    ['an id that does not match its coordinates', 'tile_colors/v2_2_0', { tx: 1, ty: 0, colors: colors() }],
    ['a tile filed under another region', 'tile_colors/v2_16_0', { tx: 16, ty: 0, colors: colors() }],
    ['a short color array', 'tile_colors/v2_1_0', { tx: 1, ty: 0, colors: Buffer.alloc(3) }],
    ['an invalid color', 'tile_colors/v2_1_0', { tx: 1, ty: 0, colors: colors(17) }],
  ])('refuses %s', async (_case, path, data) => {
    const { db } = fakeDb({ [path]: { canvas_version: 2, region: '0_0', updated_at: at, ...data } });
    await expect(createFirestoreTileStore(db).regionTiles(2, '0_0')).rejects.toThrow(StoredDataError);
  });

  it('returns author names and dates only, never the Discord or event id', async () => {
    const { db } = fakeDb({ 'tile_metadata/v2_0_0': { canvas_version: 2, tx: 0, ty: 0, region: '0_0', updated_at: at,
      pixels: { 129: { uid: '423456789012345678', name: 'Eliott', at, eid: Buffer.alloc(16) } } } });
    const authors = await createFirestoreTileStore(db).tileAuthors(2, 0, 0);
    expect(authors).toEqual({ 129: { name: 'Eliott', at } });
    expect(JSON.stringify(authors)).not.toContain('423456789012345678');
  });

  it('returns no author for a tile that was never painted', async () => {
    await expect(createFirestoreTileStore(fakeDb({}).db).tileAuthors(2, 0, 0)).resolves.toEqual({});
  });

  it.each([
    ['another version', { canvas_version: 1, pixels: {} }],
    ['missing pixels', { canvas_version: 2 }],
    ['an index out of the tile', { canvas_version: 2, pixels: { 4096: { name: 'x', at } } }],
    ['a non canonical index', { canvas_version: 2, pixels: { '01': { name: 'x', at } } }],
    ['a nameless pixel', { canvas_version: 2, pixels: { 1: { at } } }],
    ['a missing date', { canvas_version: 2, pixels: { 1: { name: 'x' } } }],
    ['an invalid date', { canvas_version: 2, pixels: { 1: { name: 'x', at: { seconds: 1, nanoseconds: -1 } } } }],
  ])('refuses metadata with %s', async (_case, data) => {
    const { db } = fakeDb({ 'tile_metadata/v2_0_0': { tx: 0, ty: 0, ...data } });
    await expect(createFirestoreTileStore(db).tileAuthors(2, 0, 0)).rejects.toThrow(StoredDataError);
  });

  it('reads the caller usage and override, absent documents as null', async () => {
    const usage = { used_pixels: 3 };
    const store = createFirestoreTileStore(fakeDb({ 'users/1': usage, 'ratelimit_overrides/2': { limit_per_minute: 5 } }).db);
    await expect(store.user('1')).resolves.toEqual({ usage, override: null });
    await expect(store.user('2')).resolves.toEqual({ usage: null, override: { limit_per_minute: 5 } });
  });
});
