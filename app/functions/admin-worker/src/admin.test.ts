import { describe, expect, it } from 'vitest';
import type { Firestore } from '@google-cloud/firestore';
import { AdminProcessingError, createAdminProcessor } from './admin';
import { purgeOldVersions } from './purge';

// In-memory double of the few Firestore calls used here; the emulator test covers the real SDK.
function fakeDb(initial: Record<string, Record<string, unknown>> = {}) {
  const docs = new Map(Object.entries(initial));
  const ref = (path: string) => ({ path, get: async () => snapshot(path) });
  const snapshot = (path: string) => ({ exists: docs.has(path), data: () => docs.get(path) });
  const db = {
    doc: ref,
    runTransaction: async <T>(work: (tx: unknown) => Promise<T>) => {
      const writes: [string, Record<string, unknown>, 'set' | 'update' | 'create'][] = [];
      const tx = {
        get: async (r: { path: string }) => snapshot(r.path),
        update: (r: { path: string }, data: Record<string, unknown>) => writes.push([r.path, data, 'update']),
        set: (r: { path: string }, data: Record<string, unknown>) => writes.push([r.path, data, 'set']),
        create: (r: { path: string }, data: Record<string, unknown>) => writes.push([r.path, data, 'create']),
      };
      const value = await work(tx);
      for (const [path, data, mode] of writes) docs.set(path, mode === 'update' ? { ...docs.get(path), ...data } : data);
      return value;
    },
    collection: (collection: string) => {
      let threshold = 0; let size = Infinity;
      const query = {
        where: (_field: string, _op: string, value: number) => { threshold = value; return query; },
        select: () => query,
        limit: (value: number) => { size = value; return query; },
        get: async () => {
          const found = [...docs.entries()]
            .filter(([path, data]) => path.startsWith(`${collection}/`) && (data.canvas_version as number) < threshold)
            .slice(0, size).map(([path]) => ({ ref: { path } }));
          return { empty: found.length === 0, size: found.length, docs: found };
        },
      };
      return query;
    },
    batch: () => {
      const deletes: string[] = [];
      return { delete: (r: { path: string }) => deletes.push(r.path), commit: async () => { for (const path of deletes) docs.delete(path); } };
    },
  };
  return { db: db as unknown as Firestore, docs };
}
const config = { paused: false, canvas_version: 3, size: null, bounds: { min_x: 0, min_y: 0, max_x: 5, max_y: 5 }, default_limit_per_minute: 20 };
const ID = '11111111-1111-4111-8111-111111111111';
const NOW = Date.parse('2026-11-20T12:00:00.000Z');
const setup = (initial = { 'config/global': config }) => {
  const { db, docs } = fakeDb(initial);
  return { docs, apply: createAdminProcessor(db, { now: () => NOW }), db };
};

describe('admin transaction', () => {
  it.each([['pause', true], ['resume', false]] as const)('%s sets the pause flag only', async (subcommand, paused) => {
    const { apply, docs } = setup();
    expect(await apply(ID, { subcommand }, 'u')).toEqual({ result: { status: 'applied', subcommand }, replayed: false });
    expect(docs.get('config/global')).toEqual({ ...config, paused });
  });

  it('clears by incrementing the canvas version and resetting the painted bounds', async () => {
    const { apply, docs } = setup();
    expect((await apply(ID, { subcommand: 'clear' }, 'u')).result).toEqual({ status: 'applied', subcommand: 'clear', canvas_version: 4 });
    expect(docs.get('config/global')).toMatchObject({ canvas_version: 4, bounds: null, paused: false, default_limit_per_minute: 20 });
  });

  it('never clears twice for a redelivered command', async () => {
    const { apply, docs } = setup();
    await apply(ID, { subcommand: 'clear' }, 'u');
    expect(await apply(ID, { subcommand: 'clear' }, 'u')).toEqual({
      result: { status: 'applied', subcommand: 'clear', canvas_version: 4 }, replayed: true });
    expect(docs.get('config/global')!.canvas_version).toBe(4);
    expect(docs.get(`admin_events/${ID}`)).toMatchObject({ schema_version: 1, event_id: ID, subcommand: 'clear', actor_uid: 'u' });
  });

  it('refuses the same event id for another subcommand, and a corrupt record', async () => {
    const { apply } = setup();
    await apply(ID, { subcommand: 'pause' }, 'u');
    await expect(apply(ID, { subcommand: 'clear' }, 'u')).rejects.toMatchObject({ code: 'event_id_conflict' });
    const corrupt = setup({ 'config/global': config, [`admin_events/${ID}`]: { schema_version: 2 } } as never);
    await expect(corrupt.apply(ID, { subcommand: 'pause' }, 'u')).rejects.toBeInstanceOf(AdminProcessingError);
  });

  it('sets or removes the grid size', async () => {
    const { apply, docs } = setup();
    await apply(ID, { subcommand: 'size', width: 10_000, height: 20_000 }, 'u');
    expect(docs.get('config/global')!.size).toEqual({ width: 10_000, height: 20_000 });
    await apply('22222222-2222-4222-8222-222222222222', { subcommand: 'size' }, 'u');
    expect(docs.get('config/global')!.size).toBeNull();
    await expect(apply('33333333-3333-4333-8333-333333333333', { subcommand: 'size', width: 5, height: 20_000 }, 'u')).rejects.toThrow(RangeError);
  });

  it('writes the user override without touching the usage counter', async () => {
    const usage = { window_start: { seconds: 1, nanoseconds: 0 }, used_pixels: 7 };
    const { apply, docs } = setup({ 'config/global': config, 'users/623456789012345678': usage } as never);
    expect((await apply(ID, { subcommand: 'ratelimit', user: '623456789012345678', limit: 0 }, 'u')).result)
      .toEqual({ status: 'applied', subcommand: 'ratelimit', user: '623456789012345678', limit: 0 });
    expect(docs.get('ratelimit_overrides/623456789012345678')).toMatchObject({ limit_per_minute: 0 });
    expect(docs.get('users/623456789012345678')).toEqual(usage);
  });

  it.each([['absent', undefined], ['without a valid version', { ...config, canvas_version: 0 }]])(
    'changes nothing when the configuration is %s', async (_case, value) => {
      const { apply, docs } = setup(value ? { 'config/global': value } : {} as never);
      expect((await apply(ID, { subcommand: 'pause' }, 'u')).result)
        .toEqual({ status: 'rejected', subcommand: 'pause', reason: 'configuration_missing' });
      expect(docs.get('config/global')).toEqual(value);
    });
});

describe('purge of old canvas versions', () => {
  const tiles = (versions: number[]) => Object.fromEntries(versions.flatMap((version, index) => [
    [`tile_colors/v${version}_${index}_0`, { canvas_version: version }],
    [`tile_metadata/v${version}_${index}_0`, { canvas_version: version }],
  ]));

  it('deletes colors and metadata of older versions only, in batches', async () => {
    const { db, docs } = fakeDb(tiles([1, 2, 2, 3, 3]));
    expect(await purgeOldVersions(db, 3, { batchSize: 2 })).toEqual({ deleted: 6, complete: true });
    expect([...docs.keys()].sort()).toEqual(['tile_colors/v3_3_0', 'tile_colors/v3_4_0', 'tile_metadata/v3_3_0', 'tile_metadata/v3_4_0']);
  });

  it('stops at its time budget and resumes on the next run', async () => {
    const { db, docs } = fakeDb(tiles([1, 1, 1]));
    let clock = 0;
    const first = await purgeOldVersions(db, 2, { batchSize: 1, budgetMs: 2, now: () => clock++ });
    expect(first.complete).toBe(false);
    expect(await purgeOldVersions(db, 2)).toEqual({ deleted: 6 - first.deleted, complete: true });
    expect(docs.size).toBe(0);
  });

  it('refuses an invalid batch size', async () => {
    await expect(purgeOldVersions(fakeDb().db, 2, { batchSize: 501 })).rejects.toThrow(RangeError);
  });
});
