import { describe, expect, it } from 'vitest';
import { TILE_PIXELS, tileRegionId } from '@pixelwar/shared/grid';
import { overviewObjectName } from '@pixelwar/shared/overview';
import { decodeIndexedPng, encodeIndexedPng } from '@pixelwar/shared/render';
import { DELTA_HORIZON_MS, DELTA_OVERLAP_MS, runOverviewCycle } from './cycle';
import { ConcurrentCycleError, type OverviewBucket, type OverviewState, type OverviewStore, type StoredTile } from './store';

const now = Date.parse('2026-11-26T12:00:00.000Z');

/** In-memory Firestore: tiles per version, and deltas as (version, region, created_at). */
function fakeStore(version = 1) {
  const tiles = new Map<string, StoredTile>();
  const deltas: { version: number; region: string; at: number }[] = [];
  const config = { canvas_version: version, size: null };
  const store: OverviewStore = {
    async config() { return { ...config }; },
    async changedRegions(v, since) { return new Set(deltas.filter((d) => d.version === v && d.at >= since).map((d) => d.region)); },
    async paintedRegions(v) { return new Set([...tiles].filter(([k]) => k.startsWith(`v${v}_`)).map(([, t]) => tileRegionId(t.tx, t.ty))); },
    async regionTiles(v, region) { return [...tiles].filter(([k, t]) => k.startsWith(`v${v}_`) && tileRegionId(t.tx, t.ty) === region).map(([, t]) => t); },
  };
  /** Paints one grid pixel with a stored colour (1-16), and records its delta. */
  const paint = (x: number, y: number, color: number, at = now) => {
    const tx = Math.floor(x / 64); const ty = Math.floor(y / 64);
    const id = `v${config.canvas_version}_${tx}_${ty}`;
    const tile = tiles.get(id) ?? { tx, ty, colors: new Uint8Array(TILE_PIXELS) };
    tile.colors[(y - ty * 64) * 64 + (x - tx * 64)] = color;
    tiles.set(id, tile);
    deltas.push({ version: config.canvas_version, region: tileRegionId(tx, ty), at });
  };
  return { store, paint, config, tiles, deltas };
}

function fakeBucket() {
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
  return { bucket, objects, state: () => state?.value };
}

/** PNG index at a grid point inside a cell image (stored colour c is PNG index c - 1). */
function indexAt(objects: Map<string, Uint8Array>, version: number, level: 1 | 2 | 3, x: number, y: number) {
  const span = 256 * 4 ** level; const scale = 4 ** level;
  const cx = Math.floor(x / span); const cy = Math.floor(y / span);
  const png = objects.get(overviewObjectName(version, level, cx, cy));
  if (!png) return undefined;
  const image = decodeIndexedPng(png);
  return image.indices[Math.floor((y - cy * span) / scale) * 256 + Math.floor((x - cx * span) / scale)];
}

describe('runOverviewCycle', () => {
  it('builds the three levels of every painted region on the first cycle', async () => {
    const { store, paint } = fakeStore(); const { bucket, objects, state } = fakeBucket();
    paint(5, 9, 3); paint(-2000, 70_000, 7);
    const summary = await runOverviewCycle({ store, bucket, now: () => now });
    expect(summary).toEqual({ mode: 'full', canvas_version: 1, rendered: { 1: 2, 2: 2, 3: 2 }, removed: 0, pending: 0 });
    for (const level of [1, 2, 3] as const) {
      expect(indexAt(objects, 1, level, 5, 9)).toBe(2);
      expect(indexAt(objects, 1, level, -2000, 70_000)).toBe(6);
    }
    expect(indexAt(objects, 1, 1, 500, 500)).toBe(0); // Unpainted pixel of a painted region: white.
    expect(state()).toEqual({ schema_version: 1, canvas_version: 1, cursor_ms: now, pending: [] });
  });

  it('then re-renders only the regions of recent deltas, and their parents', async () => {
    const { store, paint } = fakeStore(); const { bucket, objects } = fakeBucket();
    paint(5, 9, 3, now - 3_600_000); paint(5000, 0, 4, now - 3_600_000);
    await runOverviewCycle({ store, bucket, now: () => now });
    const before = objects.get(overviewObjectName(1, 1, 4, 0));
    paint(6, 9, 5, now + 30_000);
    const summary = await runOverviewCycle({ store, bucket, now: () => now + 60_000 });
    expect(summary).toMatchObject({ mode: 'incremental', rendered: { 1: 1, 2: 1, 3: 1 } });
    expect(indexAt(objects, 1, 1, 6, 9)).toBe(4);
    expect(indexAt(objects, 1, 3, 6, 9)).toBe(4); // Colour over white: the newest pixel wins its 64×64 block.
    expect(objects.get(overviewObjectName(1, 1, 4, 0))).toBe(before); // Untouched region: same object.
  });

  it('reads the deltas again from the overlap before the previous cycle', async () => {
    const { store, paint } = fakeStore(); const { bucket } = fakeBucket();
    await runOverviewCycle({ store, bucket, now: () => now });
    // Committed late with an earlier created_at, as a slow transaction would.
    paint(1, 1, 2, now - DELTA_OVERLAP_MS + 1);
    expect((await runOverviewCycle({ store, bucket, now: () => now + 60_000 })).rendered[1]).toBe(1);
  });

  it('spreads a large rebuild over several cycles, oldest first', async () => {
    const { store, paint } = fakeStore(); const { bucket, state } = fakeBucket();
    const old = now - 10 * 60_000; // Outside the overlap of the next cycle.
    paint(0, 0, 2, old); paint(2000, 0, 2, old); paint(4000, 0, 2, old);
    expect((await runOverviewCycle({ store, bucket, now: () => now, maxRegions: 2 })).pending).toBe(1);
    expect(state()?.pending).toEqual(['3_0']);
    const second = await runOverviewCycle({ store, bucket, now: () => now + 60_000, maxRegions: 2 });
    expect(second).toMatchObject({ mode: 'incremental', rendered: { 1: 1 }, pending: 0 });
  });

  it('rebuilds everything after /admin clear and removes the images of the old version', async () => {
    const { store, paint, config } = fakeStore(); const { bucket, objects } = fakeBucket();
    paint(5, 9, 3);
    await runOverviewCycle({ store, bucket, now: () => now });
    config.canvas_version = 2;
    paint(10, 10, 6);
    expect(await runOverviewCycle({ store, bucket, now: () => now + 60_000 })).toMatchObject({ mode: 'full', canvas_version: 2 });
    expect([...objects.keys()].every((name) => name.startsWith('v2/'))).toBe(true);
    expect(indexAt(objects, 2, 1, 10, 10)).toBe(5);
    expect(indexAt(objects, 2, 1, 5, 9)).toBe(0);
  });

  it('rebuilds everything when the deltas may have expired', async () => {
    const { store, paint } = fakeStore(); const { bucket } = fakeBucket();
    paint(5, 9, 3);
    await runOverviewCycle({ store, bucket, now: () => now });
    expect((await runOverviewCycle({ store, bucket, now: () => now + DELTA_HORIZON_MS + 1 })).mode).toBe('full');
  });

  it('removes the image of an area where nothing is painted any more', async () => {
    const { store, paint, tiles } = fakeStore(); const { bucket, objects } = fakeBucket();
    paint(5, 9, 3);
    await runOverviewCycle({ store, bucket, now: () => now });
    tiles.clear(); paint(5, 9, 3, now + 30_000); tiles.clear(); // A delta, but no tile left.
    const summary = await runOverviewCycle({ store, bucket, now: () => now + 60_000 });
    expect(summary).toMatchObject({ rendered: { 1: 0, 2: 0, 3: 0 }, removed: 3 });
    expect(objects.size).toBe(0);
  });

  it('writes nothing on an empty canvas', async () => {
    const { store } = fakeStore(); const { bucket, objects, state } = fakeBucket();
    expect(await runOverviewCycle({ store, bucket, now: () => now })).toMatchObject({ rendered: { 1: 0, 2: 0, 3: 0 }, removed: 0 });
    expect(objects.size).toBe(0);
    expect(state()?.cursor_ms).toBe(now);
  });

  it('refuses a stored image of the wrong size instead of drawing it', async () => {
    const { store, paint } = fakeStore(); const { bucket, objects } = fakeBucket();
    paint(0, 0, 2, now - 10 * 60_000); paint(1100, 0, 2, now - 10 * 60_000);
    await runOverviewCycle({ store, bucket, now: () => now });
    objects.set(overviewObjectName(1, 1, 1, 0), encodeIndexedPng({ width: 2, height: 2, indices: new Uint8Array(4) }));
    paint(1, 0, 3, now + 30_000);
    await expect(runOverviewCycle({ store, bucket, now: () => now + 60_000 })).rejects.toThrow('unexpected size');
  });

  it('lets the first of two concurrent cycles win', async () => {
    const { store, paint } = fakeStore(); const { bucket } = fakeBucket();
    paint(0, 0, 2);
    const results = await Promise.allSettled([
      runOverviewCycle({ store, bucket, now: () => now }), runOverviewCycle({ store, bucket, now: () => now }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({ reason: expect.any(ConcurrentCycleError) });
  });
});
