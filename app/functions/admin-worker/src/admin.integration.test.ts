import { randomUUID } from 'node:crypto';
import { Firestore } from '@google-cloud/firestore';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createDrawProcessor, type DrawCommand } from '@pixelwar/shared/drawing';
import { testProjectId } from '../../../testing/emulator-environment';
import { createAdminProcessor } from './admin';
import { purgeOldVersions } from './purge';

// Admin effects observed through the real DATA-02 transaction on the Firestore emulator.
const now = Date.parse('2026-11-20T12:00:30.000Z');
const db = new Firestore({ projectId: testProjectId });
const roots: string[] = [];
let root: string;
const USER = '623456789012345678';
const admin = () => createAdminProcessor(db, { root, now: () => now });
const draw = (pixels: DrawCommand['pixels'], uid = USER) => createDrawProcessor(db, { root, now: () => now })({
  event_id: randomUUID(), occurred_at: new Date(now - 1000).toISOString(), source: 'web', author: { uid, name: 'Eliott' }, pixels,
});
const config = async () => (await db.doc(`${root}/config/global`).get()).data()!;
const count = async (collection: string) => (await db.collection(`${root}/${collection}`).get()).size;

beforeEach(async () => {
  root = `admin_tests/${randomUUID()}`;
  roots.push(root);
  await db.doc(`${root}/config/global`).set({ paused: false, canvas_version: 1, size: null, bounds: null, default_limit_per_minute: 20 });
});
afterAll(async () => {
  try { for (const path of roots) await db.recursiveDelete(db.doc(path)); }
  finally { await db.terminate(); }
});

describe('admin commands on the Firestore emulator', () => {
  it('rejects drawings during a pause and accepts them after resume (DATA-04)', async () => {
    await admin()(randomUUID(), { subcommand: 'pause' }, 'admin');
    expect(await draw([{ x: 1, y: 1, color: 2 }])).toMatchObject({ type: 'pixel-rejected', reason: 'paused' });
    await admin()(randomUUID(), { subcommand: 'resume' }, 'admin');
    expect(await draw([{ x: 1, y: 1, color: 2 }])).toMatchObject({ type: 'pixel-processed', applied_pixels: 1 });
  });

  it('clears once even when redelivered, then the old tiles are no longer part of the grid', async () => {
    await draw([{ x: 1, y: 1, color: 2 }, { x: 100, y: 100, color: 3 }]);
    expect((await config()).bounds).toEqual({ min_x: 1, min_y: 1, max_x: 100, max_y: 100 });
    const id = randomUUID();
    const [first, again] = await Promise.all([admin()(id, { subcommand: 'clear' }, 'admin'), admin()(id, { subcommand: 'clear' }, 'admin')]);
    expect([first.replayed, again.replayed].sort()).toEqual([false, true]);
    expect(await config()).toMatchObject({ canvas_version: 2, bounds: null, paused: false });

    // A new drawing lives in version 2, next to the old documents of version 1.
    await draw([{ x: 1, y: 1, color: 5 }]);
    const current = await db.collection(`${root}/tile_colors`).where('canvas_version', '==', 2).get();
    expect(current.docs.map((doc) => doc.id)).toEqual(['v2_0_0']);
    expect(await count('tile_colors')).toBe(3);

    expect(await purgeOldVersions(db, 2, { root, batchSize: 1 })).toEqual({ deleted: 4, complete: true });
    expect((await db.collection(`${root}/tile_colors`).get()).docs.map((doc) => doc.id)).toEqual(['v2_0_0']);
    expect((await db.collection(`${root}/tile_metadata`).get()).docs.map((doc) => doc.id)).toEqual(['v2_0_0']);
  });

  it('bounds the grid: DATA-02 rejects pixels outside, then accepts them once infinite again', async () => {
    await admin()(randomUUID(), { subcommand: 'size', width: 10_000, height: 10_000 }, 'admin');
    expect(await draw([{ x: -1, y: 0, color: 2 }])).toMatchObject({ type: 'pixel-rejected', reason: 'out_of_bounds' });
    await admin()(randomUUID(), { subcommand: 'size' }, 'admin');
    expect(await draw([{ x: -1, y: 0, color: 2 }])).toMatchObject({ type: 'pixel-processed' });
  });

  it('applies a user quota override without resetting the usage of the current minute', async () => {
    await draw([{ x: 1, y: 1, color: 2 }, { x: 2, y: 1, color: 2 }]);
    await admin()(randomUUID(), { subcommand: 'ratelimit', user: USER, limit: 3 }, 'admin');
    expect((await db.doc(`${root}/users/${USER}`).get()).get('used_pixels')).toBe(2);
    expect(await draw([{ x: 3, y: 1, color: 2 }, { x: 4, y: 1, color: 2 }])).toMatchObject({ type: 'pixel-rejected', reason: 'rate_limit' });
    expect(await draw([{ x: 3, y: 1, color: 2 }])).toMatchObject({ type: 'pixel-processed' });
    await admin()(randomUUID(), { subcommand: 'ratelimit', user: USER, limit: 0 }, 'admin');
    expect(await draw([{ x: 9, y: 9, color: 2 }])).toMatchObject({ type: 'pixel-rejected', reason: 'rate_limit' });
    expect(await draw([{ x: 9, y: 9, color: 2 }], '723456789012345678')).toMatchObject({ type: 'pixel-processed' });
  });

  it('changes nothing without a configuration document', async () => {
    await db.doc(`${root}/config/global`).delete();
    expect((await admin()(randomUUID(), { subcommand: 'pause' }, 'admin')).result).toMatchObject({ status: 'rejected' });
    expect((await db.doc(`${root}/config/global`).get()).exists).toBe(false);
  });
});
