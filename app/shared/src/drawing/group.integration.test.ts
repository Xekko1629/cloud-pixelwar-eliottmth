import { randomUUID } from 'node:crypto';
import { Firestore } from '@google-cloud/firestore';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { testProjectId } from '../../../testing/emulator-environment';
import { compareEvents, locatePixel, tileId } from '../grid';
import type { DrawCommand } from './command';
import { createGroupDrawProcessor, type GroupTiming } from './group';
import { createGroupCommit } from './group-commit';
import { createDrawProcessor } from './transaction';

const now = Date.parse('2026-11-19T10:00:30.000Z');
const uid = '123456789012345678';
const db = new Firestore({ projectId: testProjectId });
const roots: string[] = [];
let root: string;
const ref = (path: string) => db.doc(`${root}/${path}`);
const command = (changes: Partial<DrawCommand> = {}): DrawCommand => ({
  event_id: randomUUID(), occurred_at: new Date(now - Math.floor(Math.random() * 5000)).toISOString(), source: 'web',
  author: { uid, name: 'Test user' }, pixels: [{ x: Math.floor(Math.random() * 8), y: 0, color: 1 + Math.floor(Math.random() * 16) }],
  ...changes,
});
const group = () => createGroupDrawProcessor(db, { root, now: () => now });
const single = () => createDrawProcessor(db, { root, now: () => now });

beforeEach(async () => {
  root = `group_tests/${randomUUID()}`;
  roots.push(root);
  await ref('config/global').set({ paused: false, canvas_version: 1, size: null, bounds: null, default_limit_per_minute: 25 });
});
afterAll(async () => {
  try { for (const path of roots) await db.recursiveDelete(db.doc(path)); }
  finally { await db.terminate(); }
});

describe('group commit on the Firestore emulator (ADR-0014)', () => {
  it('commits a whole stroke in one transaction: quota, tiles, one delta, every result', async () => {
    const stroke = Array.from({ length: 20 }, (_, x) => command({ pixels: [{ x, y: 0, color: 2 }] }));
    const results = await group()(stroke);
    expect(results.every((result) => result.type === 'pixel-processed' && result.applied_pixels === 1)).toBe(true);
    expect((await ref(`users/${uid}`).get()).get('used_pixels')).toBe(20);
    expect((await db.collection(`${root}/deltas`).get()).size).toBe(1);
    expect((await db.collection(`${root}/processed_events`).get()).size).toBe(20);
    expect([...(await ref(`tile_colors/${tileId(1, 0, 0)}`).get()).get('colors').subarray(0, 21)]).toEqual([...Array(20).fill(2), 0]);
  });

  it('keeps the quota exact and the newest pixel when two instances commit groups at the same time', async () => {
    const commands = Array.from({ length: 30 }, () => command());
    // Two instances, each with its own group: Firestore serializes their transactions.
    const results = (await Promise.all([group()(commands.slice(0, 15)), group()(commands.slice(15))])).flat();
    const accepted = results.filter((result) => result.type === 'pixel-processed');
    expect(accepted).toHaveLength(25);
    expect(results.filter((result) => result.reason === 'rate_limit')).toHaveLength(5);
    expect((await ref(`users/${uid}`).get()).get('used_pixels')).toBe(25);

    // Last-write-wins per pixel, whatever the commit order of the two groups.
    const acceptedIds = new Set(accepted.map((result) => result.event_id));
    const colors = (await ref(`tile_colors/${tileId(1, 0, 0)}`).get()).get('colors');
    for (let x = 0; x < 8; x++) {
      const winner = commands.filter((c) => acceptedIds.has(c.event_id) && c.pixels[0].x === x).sort(compareEvents).at(-1);
      expect(colors[locatePixel(x, 0).index]).toBe(winner?.pixels[0].color ?? 0);
    }
  });

  it('returns the same results when a group is delivered again', async () => {
    const commands = Array.from({ length: 5 }, (_, x) => command({ pixels: [{ x, y: 3, color: 4 }] }));
    const first = await group()(commands);
    expect(await group()([...commands].reverse())).toEqual([...first].reverse());
    expect((await ref(`users/${uid}`).get()).get('used_pixels')).toBe(5);
  });

  it('updates only the changed entries of an existing tile and keeps the others (writeTile)', async () => {
    const at = (ms: number) => new Date(ms).toISOString();
    await group()(Array.from({ length: 5 }, (_, x) => command({ occurred_at: at(now - 10_000), pixels: [{ x, y: 0, color: 3 }] })));
    const timings: GroupTiming[] = [];
    // A newer group on the same tile, then one lone command (createDrawProcessor).
    await createGroupDrawProcessor(db, { root, now: () => now }, (timing) => { timings.push(timing); })([
      command({ occurred_at: at(now - 1000), pixels: [{ x: 2, y: 0, color: 7 }] }),
      command({ occurred_at: at(now - 1000), pixels: [{ x: 10, y: 0, color: 8 }] }),
    ]);
    await single()(command({ occurred_at: at(now), pixels: [{ x: 11, y: 0, color: 9 }] }));
    expect(timings.map(({ tile_fields, tile_rewrites }) => ({ tile_fields, tile_rewrites }))).toEqual([{ tile_fields: 2, tile_rewrites: 0 }]);
    const id = tileId(1, 0, 0);
    const pixels = (await ref(`tile_metadata/${id}`).get()).get('pixels') as Record<string, unknown>;
    const painted = [0, 1, 2, 3, 4, 10, 11].map((x) => String(locatePixel(x, 0).index));
    expect(Object.keys(pixels).sort()).toEqual([...painted].sort());
    const colors = (await ref(`tile_colors/${id}`).get()).get('colors');
    expect([0, 1, 2, 3, 4, 10, 11].map((x) => colors[locatePixel(x, 0).index])).toEqual([3, 3, 7, 3, 3, 8, 9]);
  });

  it('isolates a faulty command: the others of its group are still drawn', async () => {
    await ref(`tile_colors/${tileId(1, 1, 0)}`).set({ colors: Buffer.alloc(4096) }); // Corrupt tile at x = 64..127.
    const process = createGroupCommit(single(), group(), { max_group: 32 });
    const commands = [command({ pixels: [{ x: 0, y: 0, color: 1 }] }), command({ pixels: [{ x: 64, y: 0, color: 1 }] }),
      command({ pixels: [{ x: 1, y: 0, color: 1 }] }), command({ pixels: [{ x: 2, y: 0, color: 1 }] })];
    const outcomes = await Promise.allSettled(commands.map((c) => process(c)));
    expect(outcomes.map((outcome) => outcome.status)).toEqual(['fulfilled', 'rejected', 'fulfilled', 'fulfilled']);
    expect((await ref(`users/${uid}`).get()).get('used_pixels')).toBe(3);
    expect((await db.collection(`${root}/processed_events`).get()).size).toBe(3);
  });
});
