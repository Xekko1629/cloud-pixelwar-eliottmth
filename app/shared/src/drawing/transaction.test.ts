import { randomUUID } from 'node:crypto';
import { Timestamp, type Firestore } from '@google-cloud/firestore';
import { describe, expect, it, vi } from 'vitest';
import { tileId } from '../grid';
import { MAX_DRAW_AGE_MS, type DrawCommand, type DrawOptions } from './command';
import { createDrawProcessor, processAndPublishDraw } from './transaction';

const now = Date.parse('2026-11-19T10:00:30.000Z');
const uid = '123456789012345678';
const input = (changes: Partial<DrawCommand> = {}): DrawCommand => ({
  event_id: randomUUID(), occurred_at: new Date(now).toISOString(), source: 'web',
  author: { uid, name: 'Test user' }, pixels: [{ x: 0, y: 0, color: 1 }], ...changes,
});

// Unit-only transaction double. Real atomicity and retries are tested on the emulator.
function setup(options: DrawOptions = {}, root = '') {
  const store = new Map<string, Record<string, unknown>>();
  const path = (p: string) => root ? `${root}/${p}` : p;
  const config = { paused: false, canvas_version: 1, size: null, bounds: null, default_limit_per_minute: 20 };
  store.set(path('config/global'), config);
  const snapshot = (ref: { path: string }) => ({ exists: store.has(ref.path), data: () => store.get(ref.path) });
  const writes: (() => void)[] = [];
  const tx = {
    get: vi.fn(async (ref) => snapshot(ref)),
    getAll: vi.fn(async (...refs) => refs.map(snapshot)),
    create: vi.fn((ref, data) => { writes.push(() => { store.set(ref.path, data); }); }),
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
  const process = createDrawProcessor(db, { now: () => now, root, ...options });
  return { process, store, config, tx, path };
}

describe('transaction orchestration', () => {
  it('writes all business effects after reading all affected tiles', async () => {
    const { process, store, tx } = setup();
    const result = await process(input());
    expect(result).toMatchObject({ type: 'pixel-processed', applied_pixels: 1, ignored_pixels: 0 });
    expect(store.get(`users/${uid}`)?.used_pixels).toBe(1);
    expect(tx.getAll.mock.invocationCallOrder.at(-1)).toBeLessThan(tx.set.mock.invocationCallOrder[0]);
    expect(tx.create).toHaveBeenCalledTimes(2); // Delta + stable result.
  });
  it('supports an isolated Firestore document root', async () => {
    const { process, store } = setup({}, 'tests/unit');
    await process(input());
    expect([...store.keys()].every((p) => p.startsWith('tests/unit/'))).toBe(true);
  });
  it('returns a stored decision without consulting current config or charging again', async () => {
    const { process, store } = setup(); const command = input();
    const first = await process(command);
    store.delete('config/global');
    expect(await process(command)).toEqual(first);
    expect(store.get(`users/${uid}`)?.used_pixels).toBe(1);
  });
  it.each([
    { paused: 'yes' }, { canvas_version: 0 }, { size: { width: 1, height: 1 } },
    { bounds: { min_x: 2, max_x: 1, min_y: 0, max_y: 0 } },
    { bounds: { min_x: 0.5, max_x: 1, min_y: 0, max_y: 0 } },
  ])('fails closed on invalid canvas configuration: %j', async (changes) => {
    const { config, process, tx } = setup(); Object.assign(config, changes);
    await expect(process(input())).rejects.toMatchObject({ code: 'invalid_state' });
    expect(tx.create).not.toHaveBeenCalled();
  });
  it('fails closed on missing configuration', async () => {
    const { store, process } = setup(); store.delete('config/global');
    await expect(process(input())).rejects.toMatchObject({ code: 'invalid_state' });
  });
  it('persists a pause rejection without creating a quota document', async () => {
    const { config, process, store } = setup(); config.paused = true;
    expect(await process(input())).toMatchObject({ type: 'pixel-rejected', reason: 'paused' });
    expect(store.has(`users/${uid}`)).toBe(false);
  });
  it('preserves existing usage while recording a rejection', async () => {
    const { process, store } = setup();
    await process(input()); store.get('config/global')!.paused = true;
    expect((await process(input())).reason).toBe('paused');
    expect(store.get(`users/${uid}`)).toMatchObject({ used_pixels: 1, last_rejection: { reason: 'paused' } });
  });
  it('rejects a lot outside bounded dimensions', async () => {
    const { config, process } = setup(); Object.assign(config, { size: { width: 10_000, height: 10_000 } });
    expect((await process(input({ pixels: [{ x: 10_000, y: 0, color: 1 }] }))).reason).toBe('out_of_bounds');
  });
  it('rejects expired commands', async () => {
    const { process } = setup();
    expect((await process(input({ occurred_at: new Date(now - MAX_DRAW_AGE_MS - 1).toISOString() }))).reason).toBe('expired');
  });
  it('rejects commands that expire during tile reads', async () => {
    const clock = vi.fn().mockReturnValueOnce(now).mockReturnValue(now + 2);
    const { process } = setup({ now: clock });
    expect((await process(input({ occurred_at: new Date(now - MAX_DRAW_AGE_MS + 1).toISOString() }))).reason).toBe('expired');
  });
  it.each([{ max_write_documents: 1 }, { max_estimated_bytes: 1 }])('rejects lots beyond the transaction budget: %j', async (options) => {
    const { process, store } = setup(options);
    expect((await process(input())).reason).toBe('batch_budget_exceeded');
    expect(store.has(`users/${uid}`)).toBe(false);
  });
  it('uses an override and refuses the whole batch at its limit', async () => {
    const { process, store } = setup();
    store.set(`ratelimit_overrides/${uid}`, { limit_per_minute: 1, updated_at: Timestamp.fromMillis(now) });
    await process(input());
    expect((await process(input())).reason).toBe('rate_limit');
    expect(store.get(`users/${uid}`)?.used_pixels).toBe(1);
  });
  it('rechecks quota after tile reads if the worker clock moves backward', async () => {
    const clock = vi.fn().mockReturnValueOnce(now).mockReturnValueOnce(now).mockReturnValueOnce(now + 60_000).mockReturnValue(now);
    const { process, config } = setup({ now: clock }); config.default_limit_per_minute = 1;
    await process(input());
    expect((await process(input())).reason).toBe('rate_limit');
  });
  it('expands existing bounds and avoids rewriting unchanged bounds', async () => {
    const { process, config, tx } = setup();
    await process(input());
    const count = tx.update.mock.calls.length;
    await process(input());
    expect(tx.update).toHaveBeenCalledTimes(count);
    await process(input({ pixels: [{ x: -1, y: 1, color: 2 }] }));
    expect(config.bounds).toBe(null); // Original input object was not mutated.
    expect(tx.update.mock.calls.at(-1)?.[1]).toEqual({ bounds: { min_x: -1, min_y: 0, max_x: 0, max_y: 1 } });
  });
  it('does not emit deltas for superseded pixels', async () => {
    const { process, store } = setup();
    await process(input());
    const result = await process(input({ occurred_at: new Date(now - 1).toISOString() }));
    expect(result).toMatchObject({ applied_pixels: 0, ignored_pixels: 1, regions: [] });
    expect([...store.keys()].filter((p) => p.startsWith('deltas/'))).toHaveLength(1);
  });
  it('does not persist anything when a tile is corrupt', async () => {
    const { process, store } = setup();
    store.set(`tile_colors/${tileId(1, 0, 0)}`, { colors: Buffer.alloc(4096) });
    await expect(process(input())).rejects.toMatchObject({ code: 'invalid_state' });
    expect(store.has(`users/${uid}`)).toBe(false);
  });
  it('publishes the committed result before resolving', async () => {
    const { process } = setup(); const publish = vi.fn().mockResolvedValue(undefined);
    const result = await processAndPublishDraw(process, publish, input());
    expect(publish).toHaveBeenCalledWith(result);
  });
});
