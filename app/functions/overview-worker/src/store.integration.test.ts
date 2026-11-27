import { randomUUID } from 'node:crypto';
import { Firestore } from '@google-cloud/firestore';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createDrawProcessor } from '@pixelwar/shared/drawing';
import { overviewObjectName } from '@pixelwar/shared/overview';
import { decodeIndexedPng } from '@pixelwar/shared/render';
import { testProjectId } from '../../../testing/emulator-environment';
import { runOverviewCycle } from './cycle';
import { ConcurrentCycleError, createFirestoreOverviewStore, type OverviewBucket, type OverviewState } from './store';

const now = Date.parse('2026-11-26T12:00:00.000Z');
const db = new Firestore({ projectId: testProjectId });
const roots: string[] = [];
let root: string;

function memoryBucket() {
  const objects = new Map<string, Uint8Array>();
  let state: { value: OverviewState; generation: number } | null = null;
  const bucket: OverviewBucket = {
    async read(name) { return objects.get(name) ?? null; },
    async write(name, png) { objects.set(name, png); },
    async remove(name) { objects.delete(name); },
    async removePrefix(prefix) { for (const name of [...objects.keys()]) if (name.startsWith(prefix)) objects.delete(name); },
    async readState() { return state ? { state: structuredClone(state.value), generation: String(state.generation) } : { state: null, generation: '0' }; },
    async writeState(value, generation) {
      if (String(state?.generation ?? 0) !== generation) throw new ConcurrentCycleError();
      state = { value: structuredClone(value), generation: (state?.generation ?? 0) + 1 };
    },
  };
  return { bucket, objects };
}
const draw = (x: number, y: number, color: number, at = now) => createDrawProcessor(db, { root, now: () => at })({
  event_id: randomUUID(), occurred_at: new Date(at).toISOString(), source: 'web',
  author: { uid: '123456789012345678', name: 'Test user' }, pixels: [{ x, y, color }],
});

beforeEach(async () => {
  root = `overview_tests/${randomUUID()}`;
  roots.push(root);
  await db.doc(`${root}/config/global`).set({ paused: false, canvas_version: 1, size: null, bounds: null, default_limit_per_minute: 100 });
});
afterAll(async () => {
  try { for (const path of roots) await db.recursiveDelete(db.doc(path)); }
  finally { await db.terminate(); }
});

describe('overview-worker on the Firestore emulator (DATA-05c)', () => {
  it('finds changed regions in the real DATA-02 deltas and renders their tiles', async () => {
    await draw(10, 20, 4, now - 30 * 60_000); await draw(-5000, 3000, 9, now - 30 * 60_000);
    const store = createFirestoreOverviewStore(db, { root });
    expect(await store.paintedRegions(1)).toEqual(new Set(['0_0', '-5_2']));
    const { bucket, objects } = memoryBucket();
    await runOverviewCycle({ store, bucket, now: () => now });
    const level1 = decodeIndexedPng(objects.get(overviewObjectName(1, 1, 0, 0))!);
    expect(level1.indices[Math.floor(20 / 4) * 256 + Math.floor(10 / 4)]).toBe(3);

    await draw(1500, 0, 6, now + 10_000);
    expect(await store.changedRegions(1, now)).toEqual(new Set(['1_0']));
    const second = await runOverviewCycle({ store, bucket, now: () => now + 60_000 });
    expect(second).toMatchObject({ mode: 'incremental', rendered: { 1: 1, 2: 1, 3: 1 } });
    expect(objects.has(overviewObjectName(1, 1, 1, 0))).toBe(true);
  });

  it('reads only the tiles of the requested region and version', async () => {
    await draw(0, 0, 2); await draw(63, 63, 3); await draw(1024, 0, 4);
    const tiles = await createFirestoreOverviewStore(db, { root }).regionTiles(1, '0_0');
    expect(tiles.map(({ tx, ty }) => `${tx},${ty}`).sort()).toEqual(['0,0']);
    expect(await createFirestoreOverviewStore(db, { root }).regionTiles(2, '0_0')).toEqual([]);
  });
});
