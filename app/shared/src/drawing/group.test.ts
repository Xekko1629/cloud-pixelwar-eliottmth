import { Timestamp, type Firestore } from '@google-cloud/firestore';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { compareEvents, decodeDelta, tileId } from '../grid';
import { MAX_DRAW_AGE_MS, type DrawCommand, type DrawOptions } from './command';
import { createGroupDrawProcessor, DrawGroupTooLargeError } from './group';
import { createDrawProcessor } from './transaction';

const now = Date.parse('2026-11-19T10:00:30.000Z');
const users = ['123456789012345678', '223456789012345678', '323456789012345678'];
let sequence = 0;
const id = () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`;
const input = (changes: Partial<DrawCommand> = {}): DrawCommand => ({
  event_id: id(), occurred_at: new Date(now).toISOString(), source: 'web',
  author: { uid: users[0], name: 'Test user' }, pixels: [{ x: 0, y: 0, color: 1 }], ...changes,
});

// Unit-only transaction double, shared by both processors. Real atomicity is tested on the emulator.
function fakeStore(config: Record<string, unknown> = {}) {
  const store = new Map<string, Record<string, unknown>>();
  store.set('config/global', { paused: false, canvas_version: 1, size: null, bounds: null, default_limit_per_minute: 20, ...config });
  const snapshot = (ref: { path: string }) => ({ exists: store.has(ref.path), data: () => store.get(ref.path) });
  const writes: (() => void)[] = [];
  const tx = {
    get: vi.fn(async (ref) => snapshot(ref)),
    getAll: vi.fn(async (...refs) => refs.map(snapshot)),
    create: vi.fn((ref, data) => { writes.push(() => { if (store.has(ref.path)) throw new Error('exists'); store.set(ref.path, data); }); }),
    set: vi.fn((ref, data, settings) => { writes.push(() => { store.set(ref.path, settings?.merge ? { ...store.get(ref.path), ...data } : data); }); }),
    update: vi.fn((ref, data) => { writes.push(() => { store.set(ref.path, { ...store.get(ref.path), ...data }); }); }),
  };
  const db = {
    doc: (path: string) => ({ path }),
    runTransaction: async (work: (transaction: typeof tx) => Promise<unknown>) => {
      writes.length = 0;
      const result = await work(tx);
      for (const write of writes) write();
      return result;
    },
  } as unknown as Firestore;
  return { db, store, tx };
}
const withoutDeltas = (store: Map<string, unknown>) => new Map([...store].filter(([path]) => !path.startsWith('deltas/')));
const deltaPixels = (store: Map<string, Record<string, unknown>>) => [...store].filter(([path]) => path.startsWith('deltas/'))
  .flatMap(([, delta]) => decodeDelta(delta.pixels as Uint8Array)).sort((a, b) => a.x - b.x || a.y - b.y);

/** Deterministic pseudo-random generator: a failing seed can be replayed. */
function random(seed: number) {
  // mulberry32: 32-bit integer arithmetic only, well spread even modulo small numbers.
  let state = seed >>> 0;
  return (n: number) => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (((t ^ (t >>> 14)) >>> 0) % n);
  };
}

describe('group commit equivalence (ADR-0014)', () => {
  const seen = new Set<string>();
  afterAll(() => {
    // Guards the generator itself: every path must have been exercised by some seed.
    expect([...seen].sort()).toEqual(['applied', 'open', 'out_of_bounds', 'paused', 'rate_limit', 'superseded']);
  });
  // Small coordinates, 3 users, a 4-pixel quota and one override: collisions, last-write-wins,
  // quota refusals and first refusals all happen inside the same group.
  it.each(Array.from({ length: 40 }, (_, seed) => seed + 1))('matches one transaction per command, seed %i', async (seed) => {
    const pick = random(seed);
    const commands = Array.from({ length: 3 + pick(20) }, () => input({
      occurred_at: new Date(now - pick(5) * 1000).toISOString(),
      author: { uid: users[pick(3)], name: 'User' },
      pixels: [{ x: [0, 40, 80, 10_000][pick(4)], y: pick(2), color: 1 + pick(16) }],
    }));
    const config = {
      default_limit_per_minute: 4, ...(pick(5) === 0 ? { paused: true } : {}),
      ...(pick(3) === 0 ? { size: { width: 10_000, height: 10_000 } } : {}), // x = 10 000 is then out of bounds.
    };
    const single = fakeStore(config); const grouped = fakeStore(config);
    // A newer pixel already stored at (0, 0): older commands of the group are superseded there.
    const previous = input({ author: { uid: users[1], name: 'User' } });
    for (const { db, store } of [single, grouped]) {
      store.set(`ratelimit_overrides/${users[2]}`, { limit_per_minute: 2, updated_at: Timestamp.fromMillis(now) });
      store.set('config/global', { ...store.get('config/global'), paused: false });
      await createDrawProcessor(db, { now: () => now })(previous);
      store.set('config/global', { ...store.get('config/global'), paused: config.paused ?? false });
    }
    const one = createDrawProcessor(single.db, { now: () => now });
    const sequential = [];
    for (const command of [...commands].sort(compareEvents)) sequential.push(await one(command));
    const results = await createGroupDrawProcessor(grouped.db, { now: () => now })(commands);
    seen.add(config.paused ? 'paused' : 'open');
    for (const result of results) seen.add(result.reason ?? (result.applied_pixels ? 'applied' : 'superseded'));

    const byId = new Map(sequential.map((result) => [result.event_id, result]));
    expect(results).toEqual(commands.map((command) => byId.get(command.event_id)));
    expect(withoutDeltas(grouped.store)).toEqual(withoutDeltas(single.store));
    // Deltas are grouped differently, but carry the same final pixels.
    const finalPixels = new Map(deltaPixels(single.store).map((p) => [`${p.x},${p.y}`, p]));
    const groupedPixels = deltaPixels(grouped.store);
    expect(new Set(groupedPixels.map((p) => `${p.x},${p.y}`)).size).toBe(groupedPixels.length);
    for (const pixel of groupedPixels) expect(finalPixels.get(`${pixel.x},${pixel.y}`)).toBeDefined();
  });
});

describe('createGroupDrawProcessor', () => {
  it('writes users, each tile and one delta per region once for the whole group', async () => {
    const { db, store, tx } = fakeStore();
    const commands = [input({ pixels: [{ x: 0, y: 0, color: 1 }] }), input({ pixels: [{ x: 1, y: 0, color: 2 }] }),
      input({ pixels: [{ x: 1, y: 0, color: 3 }] }), input({ author: { uid: users[1], name: 'Other' }, pixels: [{ x: 2000, y: 0, color: 4 }] })];
    const results = await createGroupDrawProcessor(db, { now: () => now })(commands);
    expect(results.map((r) => [r.type, r.applied_pixels])).toEqual([['pixel-processed', 1], ['pixel-processed', 1], ['pixel-processed', 1], ['pixel-processed', 1]]);
    expect(store.get(`users/${users[0]}`)).toMatchObject({ used_pixels: 3, last_rejection: null });
    const userWrites = tx.set.mock.calls.filter(([ref]) => ref.path.startsWith('users/'));
    expect(userWrites).toHaveLength(2);
    expect(tx.set.mock.calls.filter(([ref]) => ref.path === `tile_colors/${tileId(1, 0, 0)}`)).toHaveLength(1);
    const deltas = [...store.keys()].filter((path) => path.startsWith('deltas/'));
    expect(deltas.sort()).toEqual([`deltas/v1_${commands[0].event_id}_0_0`, `deltas/v1_${commands[0].event_id}_1_0`]);
    // Same coordinate twice in one group: only the final color is in the delta.
    expect(decodeDelta(store.get(deltas.sort()[0])!.pixels as Uint8Array)).toEqual([{ x: 0, y: 0, color: 1 }, { x: 1, y: 0, color: 3 }]);
  });

  it('returns the stored result of an already processed command, and the same result for a duplicate', async () => {
    const { db, store } = fakeStore();
    const done = input();
    const first = await createDrawProcessor(db, { now: () => now })(done);
    const fresh = input({ pixels: [{ x: 5, y: 5, color: 2 }] });
    const results = await createGroupDrawProcessor(db, { now: () => now })([done, fresh, fresh]);
    expect(results[0]).toEqual(first);
    expect(results[1]).toEqual(results[2]);
    expect(store.get(`users/${users[0]}`)).toMatchObject({ used_pixels: 2 });
  });

  it('writes nothing when every command was already processed', async () => {
    const { db, tx } = fakeStore();
    const done = input();
    await createDrawProcessor(db, { now: () => now })(done);
    const before = tx.set.mock.calls.length;
    await createGroupDrawProcessor(db, { now: () => now })([done]);
    expect(tx.set.mock.calls.length).toBe(before);
  });

  it('refuses an event id reused for another content before any read', async () => {
    const { db, tx } = fakeStore();
    const command = input();
    await expect(createGroupDrawProcessor(db)([command, { ...command, pixels: [{ x: 9, y: 9, color: 1 }] }]))
      .rejects.toMatchObject({ code: 'event_id_conflict' });
    await expect(createGroupDrawProcessor(db)([input({ pixels: [{ x: 0.5, y: 0, color: 1 }] })])).rejects.toMatchObject({ code: 'invalid_command' });
    await expect(createGroupDrawProcessor(db)([])).rejects.toThrow('at least one');
    expect(tx.getAll).not.toHaveBeenCalled();
  });

  it.each<[DrawOptions, string]>([
    [{ max_write_documents: 5 }, 'documents'], [{ max_estimated_bytes: 1 }, 'bytes'],
  ])('fails the whole group when it exceeds the transaction budget (%j)', async (options) => {
    const { db, store } = fakeStore();
    await expect(createGroupDrawProcessor(db, { now: () => now, ...options })([input(), input({ pixels: [{ x: 3, y: 0, color: 1 }] })]))
      .rejects.toBeInstanceOf(DrawGroupTooLargeError);
    expect([...store.keys()]).toEqual(['config/global']);
  });

  it('fails the whole group on a corrupt tile, writing nothing', async () => {
    const { db, store } = fakeStore();
    store.set(`tile_colors/${tileId(1, 0, 0)}`, { colors: Buffer.alloc(4096) });
    await expect(createGroupDrawProcessor(db, { now: () => now })([input(), input({ pixels: [{ x: 3, y: 0, color: 1 }] })]))
      .rejects.toMatchObject({ code: 'invalid_state' });
    expect(store.has(`users/${users[0]}`)).toBe(false);
  });

  it('keeps refusals without tile reads, and records the last one per user', async () => {
    const { db, store, tx } = fakeStore({ size: { width: 10_000, height: 10_000 } });
    const old = input({ occurred_at: new Date(now - MAX_DRAW_AGE_MS - 1).toISOString() });
    const outside = input({ occurred_at: new Date(now - 1).toISOString(), pixels: [{ x: 10_000, y: 0, color: 1 }] });
    const results = await createGroupDrawProcessor(db, { now: () => now })([old, outside]);
    expect(results.map((r) => r.reason)).toEqual(['expired', 'out_of_bounds']);
    expect(tx.getAll).toHaveBeenCalledTimes(2); // Results, then config and users: no tile read.
    expect(store.get(`users/${users[0]}`)).toMatchObject({ used_pixels: 0, last_rejection: { event_id: outside.event_id, reason: 'out_of_bounds' } });
  });

  it('rechecks expiry with the clock read after the tile reads', async () => {
    const clock = vi.fn().mockReturnValueOnce(now).mockReturnValue(now + 2);
    const { db } = fakeStore();
    const late = input({ occurred_at: new Date(now - MAX_DRAW_AGE_MS + 1).toISOString() });
    const results = await createGroupDrawProcessor(db, { now: clock })([late, input()]);
    expect(results.map((r) => r.type)).toEqual(['pixel-rejected', 'pixel-processed']);
    expect(results[0].reason).toBe('expired');
  });

  it('refuses a command dated in the future', async () => {
    const { db } = fakeStore();
    await expect(createGroupDrawProcessor(db, { now: () => now })([input({ occurred_at: new Date(now + 60_000).toISOString() })]))
      .rejects.toMatchObject({ code: 'future_event' });
  });

  it('updates the shared bounds once and leaves unchanged bounds alone', async () => {
    const { db, store, tx } = fakeStore();
    const process = createGroupDrawProcessor(db, { now: () => now });
    await process([input({ pixels: [{ x: -1, y: 2, color: 1 }] }), input({ pixels: [{ x: 3, y: -4, color: 1 }] })]);
    expect(store.get('config/global')!.bounds).toEqual({ min_x: -1, min_y: -4, max_x: 3, max_y: 2 });
    const updates = tx.update.mock.calls.length;
    await process([input({ pixels: [{ x: 0, y: 0, color: 1 }] }), input({ pixels: [{ x: 1, y: 1, color: 1 }] })]);
    expect(tx.update.mock.calls.length).toBe(updates);
  });

  it('supports an isolated document root', async () => {
    const { db, store } = fakeStore();
    store.set('tests/unit/config/global', store.get('config/global')!);
    await createGroupDrawProcessor(db, { now: () => now, root: 'tests/unit' })([input(), input({ pixels: [{ x: 1, y: 0, color: 1 }] })]);
    expect([...store.keys()].filter((path) => path !== 'config/global').every((path) => path.startsWith('tests/unit/'))).toBe(true);
  });
});
