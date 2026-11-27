import { randomUUID } from 'node:crypto';
import { Firestore } from '@google-cloud/firestore';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createDrawProcessor, type DrawCommand } from '@pixelwar/shared/drawing';
import { decodeRegionTiles, locatePixel } from '@pixelwar/shared/grid';
import { testProjectId } from '../../../testing/emulator-environment';
import { metaBody, regionBody, stateBody } from './responses';
import { createFirestoreTileStore } from './store';

// Written by the real DATA-02 transaction, read back by the tile-reader: proves both sides agree on storage.
const now = Date.parse('2026-11-20T10:00:30.000Z');
const db = new Firestore({ projectId: testProjectId });
const roots: string[] = [];
let root: string;
const AUTHOR = { uid: '423456789012345678', name: 'Eliott' };
const draw = (pixels: DrawCommand['pixels'], author = AUTHOR) => createDrawProcessor(db, { root, now: () => now })({
  event_id: randomUUID(), occurred_at: new Date(now - 1000).toISOString(), source: 'web', author, pixels,
});

beforeEach(async () => {
  root = `tile_reader_tests/${randomUUID()}`;
  roots.push(root);
  await db.doc(`${root}/config/global`).set({ paused: false, canvas_version: 1, size: null, bounds: null, default_limit_per_minute: 20 });
});
afterAll(async () => {
  try { for (const path of roots) await db.recursiveDelete(db.doc(path)); }
  finally { await db.terminate(); }
});

describe('tile-reader on the Firestore emulator', () => {
  it('reads back the tiles of a region drawn by DATA-02, and only that region', async () => {
    await draw([{ x: -1, y: -1, color: 5 }, { x: -1000, y: -64, color: 9 }, { x: 0, y: 0, color: 2 }]);
    const store = createFirestoreTileStore(db, { root });
    const version = (await store.config()).canvas_version;
    const tiles = await store.regionTiles(version, '-1_-1');
    const decoded = decodeRegionTiles(regionBody(version, { kind: 'tiles', rx: -1, ry: -1, region: '-1_-1' }, tiles), -1, -1);
    expect(decoded.tiles.map(({ tx, ty }) => [tx, ty])).toEqual([[-16, -1], [-1, -1]]);
    for (const [x, y, color] of [[-1, -1, 5], [-1000, -64, 9]]) {
      const { tx, ty, index } = locatePixel(x, y);
      expect(decoded.tiles.find((tile) => tile.tx === tx && tile.ty === ty)!.colors[index]).toBe(color);
    }
    expect(await store.regionTiles(version, '5_5')).toEqual([]);
  });

  it('stops serving the tiles of a previous canvas version', async () => {
    await draw([{ x: 1, y: 1, color: 3 }]);
    await db.doc(`${root}/config/global`).update({ canvas_version: 2 });
    const store = createFirestoreTileStore(db, { root });
    expect(await store.regionTiles((await store.config()).canvas_version, '0_0')).toEqual([]);
  });

  // The date of a pixel is the time of the action (occurred_at), not the processing time.
  it('serves who drew a pixel and when, without the Discord id', async () => {
    await draw([{ x: 65, y: 2, color: 4 }]);
    const store = createFirestoreTileStore(db, { root });
    const body = JSON.parse(metaBody(1, { kind: 'meta', tx: 1, ty: 0 }, await store.tileAuthors(1, 1, 0)).toString());
    expect(body.pixels).toEqual({ [locatePixel(65, 2).index]: { name: 'Eliott', at: new Date(now - 1000).toISOString() } });
    expect(JSON.stringify(body)).not.toContain(AUTHOR.uid);
  });

  it('serves the quota consumed by DATA-02 for the caller', async () => {
    await draw([{ x: 1, y: 1, color: 3 }, { x: 2, y: 1, color: 3 }]);
    await db.doc(`${root}/config/global`).update({ paused: true });
    const rejected = await draw([{ x: 3, y: 1, color: 3 }]);
    expect(rejected.type).toBe('pixel-rejected');
    const store = createFirestoreTileStore(db, { root });
    const state = JSON.parse(stateBody(await store.config(), await store.user(AUTHOR.uid), now + 5000).toString());
    expect(state.paused).toBe(true);
    expect(state.user).toMatchObject({ limit_per_minute: 20, used_pixels: 2, remaining_pixels: 18,
      last_rejection: { event_id: rejected.event_id, reason: 'paused' } });
    const other = JSON.parse(stateBody(await store.config(), await store.user('523456789012345678'), now).toString());
    expect(other.user).toMatchObject({ used_pixels: 0, last_rejection: null });
  });

  it('explains the very first action of a new user when it is refused (DRAW-04)', async () => {
    await db.doc(`${root}/config/global`).update({ paused: true });
    const rejected = await draw([{ x: 3, y: 1, color: 3 }]);
    const store = createFirestoreTileStore(db, { root });
    const state = JSON.parse(stateBody(await store.config(), await store.user(AUTHOR.uid), now + 5000).toString());
    expect(state.user).toMatchObject({ used_pixels: 0, remaining_pixels: 20,
      last_rejection: { event_id: rejected.event_id, reason: 'paused' } });
  });
});
