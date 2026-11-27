import { Timestamp, type Firestore } from '@google-cloud/firestore';
import type { Storage } from '@google-cloud/storage';
import { describe, expect, it, vi } from 'vitest';
import { TILE_PIXELS } from '@pixelwar/shared/grid';
import {
  ConcurrentCycleError, STATE_OBJECT, StoredDataError, createFirestoreOverviewStore, createGcsOverviewBucket, parseState,
} from './store';

/** Firestore double: records the query, returns the given documents. */
function fakeDb(documents: Record<string, Record<string, unknown> | undefined>, query: { id: string; data: Record<string, unknown> }[] = []) {
  const calls: unknown[][] = [];
  const result = query.map((d) => ({ id: d.id, data: () => d.data, get: (field: string) => d.data[field] }));
  const chain = {
    where: (...args: unknown[]) => { calls.push(['where', ...args]); return chain; },
    select: (...args: unknown[]) => { calls.push(['select', ...args]); return chain; },
    get: async () => ({ docs: result }),
    stream: () => (async function* () { yield* result; })(),
  };
  const db = {
    doc: (path: string) => ({ get: async () => ({ data: () => documents[path] }) }),
    collection: (path: string) => { calls.push(['collection', path]); return chain; },
  } as unknown as Firestore;
  return { db, calls };
}
const tile = (tx: number, ty: number, region = `${Math.floor(tx / 16)}_${Math.floor(ty / 16)}`) => ({
  id: `v1_${tx}_${ty}`, data: { tx, ty, region, colors: Buffer.alloc(TILE_PIXELS, 1) },
});

describe('createFirestoreOverviewStore', () => {
  it('reads the canvas version and size, and never invents a configuration', async () => {
    const config = { canvas_version: 3, size: { width: 10_000, height: 20_000 }, paused: false };
    expect(await createFirestoreOverviewStore(fakeDb({ 'r/x/config/global': config }).db, { root: 'r/x' }).config())
      .toEqual({ canvas_version: 3, size: { width: 10_000, height: 20_000 } });
    expect(await createFirestoreOverviewStore(fakeDb({ 'config/global': { canvas_version: 1, size: null } }).db).config())
      .toEqual({ canvas_version: 1, size: null });
    await expect(createFirestoreOverviewStore(fakeDb({}).db).config()).rejects.toBeInstanceOf(StoredDataError);
    await expect(createFirestoreOverviewStore(fakeDb({ 'config/global': { canvas_version: 0, size: null } }).db).config())
      .rejects.toThrow('Invalid global configuration');
  });

  it('lists the regions of the recent deltas of one version', async () => {
    const { db, calls } = fakeDb({}, [{ id: 'a', data: { region: '0_0' } }, { id: 'b', data: { region: '-1_2' } }, { id: 'c', data: { region: '0_0' } }]);
    expect(await createFirestoreOverviewStore(db).changedRegions(2, 1_000)).toEqual(new Set(['0_0', '-1_2']));
    expect(calls).toEqual([['collection', 'deltas'], ['where', 'canvas_version', '==', 2],
      ['where', 'created_at', '>=', Timestamp.fromMillis(1_000)], ['select', 'region']]);
  });

  it('lists the painted regions from the tiles, and refuses an invalid region', async () => {
    expect(await createFirestoreOverviewStore(fakeDb({}, [tile(0, 0), tile(17, 0), tile(1, 1)]).db).paintedRegions(1)).toEqual(new Set(['0_0', '1_0']));
    await expect(createFirestoreOverviewStore(fakeDb({}, [{ id: 'x', data: { region: '01_0' } }]).db).paintedRegions(1)).rejects.toThrow('Invalid region');
  });

  it('reads the tiles of one region and checks each document', async () => {
    const { db } = fakeDb({}, [tile(0, 0), tile(15, 15)]);
    const tiles = await createFirestoreOverviewStore(db).regionTiles(1, '0_0');
    expect(tiles.map(({ tx, ty }) => [tx, ty])).toEqual([[0, 0], [15, 15]]);
    expect(tiles[0].colors).toBeInstanceOf(Uint8Array);
    for (const bad of [tile(16, 0, '0_0'), { id: 'v1_9_9', data: { tx: 0, ty: 0, colors: Buffer.alloc(TILE_PIXELS) } },
      { id: 'v1_0_0', data: { tx: 0, ty: 0, colors: Buffer.alloc(3) } }, { id: 'v1_0_0', data: { tx: 'a', ty: 0 } }]) {
      await expect(createFirestoreOverviewStore(fakeDb({}, [bad]).db).regionTiles(1, '0_0')).rejects.toThrow('Inconsistent tile document');
    }
  });
});

describe('parseState', () => {
  it('accepts a valid state and refuses anything else', () => {
    const state = { schema_version: 1, canvas_version: 2, cursor_ms: 5, pending: ['0_0', '-3_4'] };
    expect(parseState(state)).toEqual(state);
    for (const bad of [null, { ...state, schema_version: 2 }, { ...state, canvas_version: 0 }, { ...state, cursor_ms: -1 },
      { ...state, pending: ['0_0', 'x'] }, { ...state, pending: 'all' }]) {
      expect(() => parseState(bad)).toThrow('Invalid overview state');
    }
  });
});

/** Cloud Storage double: objects with generations, and the preconditions of writeState. */
function fakeStorage() {
  const objects = new Map<string, { data: Buffer; generation: number; options?: unknown }>();
  let next = 1;
  const missing = () => Object.assign(new Error('No such object'), { code: 404 });
  const file = (name: string, options: { generation?: string } = {}) => ({
    async download() {
      const object = objects.get(name);
      if (!object || (options.generation && String(object.generation) !== options.generation)) throw missing();
      return [object.data];
    },
    async getMetadata() { const object = objects.get(name); if (!object) throw missing(); return [{ generation: String(object.generation) }]; },
    async save(data: Buffer | string, saveOptions: { preconditionOpts?: { ifGenerationMatch?: string } } = {}) {
      const wanted = saveOptions.preconditionOpts?.ifGenerationMatch;
      if (wanted !== undefined && String(objects.get(name)?.generation ?? 0) !== wanted) throw Object.assign(new Error('Precondition'), { code: 412 });
      objects.set(name, { data: Buffer.from(data), generation: next++, options: saveOptions });
    },
    async delete() { objects.delete(name); },
  });
  const bucket = {
    file,
    async deleteFiles({ prefix }: { prefix: string }) { for (const name of [...objects.keys()]) if (name.startsWith(prefix)) objects.delete(name); },
  };
  const storage = { bucket: vi.fn(() => bucket) } as unknown as Storage;
  return { storage, objects };
}

describe('createGcsOverviewBucket', () => {
  it('writes, reads, removes images and whole versions', async () => {
    const { storage, objects } = fakeStorage();
    const bucket = createGcsOverviewBucket(storage, 'pixelwar-test-overview');
    expect(storage.bucket).toHaveBeenCalledWith('pixelwar-test-overview');
    expect(await bucket.read('v1/1/0_0.png')).toBeNull();
    await bucket.write('v1/1/0_0.png', Uint8Array.of(1, 2)); await bucket.write('v2/1/0_0.png', Uint8Array.of(3));
    expect(await bucket.read('v1/1/0_0.png')).toEqual(Uint8Array.of(1, 2));
    expect(objects.get('v1/1/0_0.png')?.options).toMatchObject({ contentType: 'image/png', metadata: { cacheControl: 'private, max-age=60' } });
    await bucket.removePrefix('v1/');
    expect([...objects.keys()]).toEqual(['v2/1/0_0.png']);
    await bucket.remove('v2/1/0_0.png'); await bucket.remove('v2/1/0_0.png');
    expect(objects.size).toBe(0);
  });

  it('creates the state once, then only over the generation it read', async () => {
    const { storage, objects } = fakeStorage();
    const bucket = createGcsOverviewBucket(storage, 'b');
    expect(await bucket.readState()).toEqual({ state: null, generation: '0' });
    const state = { schema_version: 1 as const, canvas_version: 1, cursor_ms: 10, pending: [] };
    await bucket.writeState(state, '0');
    await expect(bucket.writeState(state, '0')).rejects.toBeInstanceOf(ConcurrentCycleError);
    const read = await bucket.readState();
    expect(read.state).toEqual(state);
    await bucket.writeState({ ...state, cursor_ms: 20 }, read.generation);
    expect(JSON.parse(objects.get(STATE_OBJECT)!.data.toString()).cursor_ms).toBe(20);
  });

  it('propagates other storage failures and refuses a corrupt state', async () => {
    const { storage, objects } = fakeStorage();
    const bucket = createGcsOverviewBucket(storage, 'b');
    objects.set(STATE_OBJECT, { data: Buffer.from('{"schema_version":9}'), generation: 7 });
    await expect(bucket.readState()).rejects.toBeInstanceOf(StoredDataError);
    const failing = { bucket: () => ({ file: () => ({
      download: async () => { throw Object.assign(new Error('denied'), { code: 403 }); },
      getMetadata: async () => { throw Object.assign(new Error('denied'), { code: 403 }); },
      save: async () => { throw Object.assign(new Error('denied'), { code: 403 }); },
    }) }) } as unknown as Storage;
    const denied = createGcsOverviewBucket(failing, 'b');
    await expect(denied.read('x')).rejects.toThrow('denied');
    await expect(denied.readState()).rejects.toThrow('denied');
    await expect(denied.writeState({ schema_version: 1, canvas_version: 1, cursor_ms: 0, pending: [] }, '0')).rejects.toThrow('denied');
  });
});
