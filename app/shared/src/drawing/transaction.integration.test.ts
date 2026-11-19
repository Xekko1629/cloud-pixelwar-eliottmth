import { randomUUID } from 'node:crypto';
import { Firestore } from '@google-cloud/firestore';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { testProjectId } from '../../../testing/emulator-environment';
import { locatePixel, tileId } from '../grid';
import { MAX_DRAW_AGE_MS, RESULT_RETENTION_MS, type DrawCommand } from './command';
import { createDrawProcessor, processAndPublishDraw } from './transaction';

const now = Date.parse('2026-11-19T10:00:30.000Z');
const db = new Firestore({ projectId: testProjectId });
const roots: string[] = [];
let root: string;
const ref = (path: string) => db.doc(`${root}/${path}`);
const command = (changes: Partial<DrawCommand> = {}): DrawCommand => ({
  event_id: randomUUID(), occurred_at: new Date(now).toISOString(), source: 'discord',
  author: { uid: '123456789012345678', name: 'Test user' }, pixels: [{ x: 0, y: 0, color: 1 }], ...changes,
});
const processor = () => createDrawProcessor(db, { root, now: () => now });

beforeEach(async () => {
  root = `draw_tests/${randomUUID()}`;
  roots.push(root);
  await ref('config/global').set({ paused: false, canvas_version: 1, size: null, bounds: null, default_limit_per_minute: 20 });
});
afterAll(async () => {
  try { for (const path of roots) await db.recursiveDelete(db.doc(path)); }
  finally { await db.terminate(); }
});

describe('atomic drawing on the Firestore emulator', () => {
  it('commits tiles, quota, deltas and a retained result together', async () => {
    const input = command({ pixels: [{ x: 0, y: 0, color: 1 }, { x: 64, y: 0, color: 2 }] });
    const result = await processor()(input);
    expect(result).toMatchObject({ type: 'pixel-processed', requested_pixels: 2, applied_pixels: 2 });
    expect((await ref('users/123456789012345678').get()).get('used_pixels')).toBe(2);
    expect((await db.collection(`${root}/tile_colors`).get()).size).toBe(2);
    expect((await db.collection(`${root}/tile_metadata`).get()).size).toBe(2);
    expect((await db.collection(`${root}/deltas`).get()).size).toBe(1);
    const stored = await ref(`processed_events/${input.event_id}`).get();
    expect(stored.get('result')).toEqual(result);
    expect(stored.get('expire_at').toMillis()).toBe(now + RESULT_RETENTION_MS);
  });

  it('deduplicates simultaneous deliveries, including quota and deltas', async () => {
    const input = command();
    const results = await Promise.all([processor()(input), processor()(input)]);
    expect(results[0]).toEqual(results[1]);
    expect((await ref('users/123456789012345678').get()).get('used_pixels')).toBe(1);
    expect((await db.collection(`${root}/deltas`).get()).size).toBe(1);
  });

  it('keeps both concurrent edits in the same tile', async () => {
    await Promise.all([
      processor()(command()),
      processor()(command({ author: { uid: '223456789012345678', name: 'Other user' }, pixels: [{ x: 1, y: 0, color: 2 }] })),
    ]);
    const colors = (await ref(`tile_colors/${tileId(1, 0, 0)}`).get()).get('colors');
    expect([...colors.slice(0, 2)]).toEqual([1, 2]);
    expect((await db.collection(`${root}/processed_events`).get()).size).toBe(2);
  });

  it('does not let an older event overwrite a newer pixel', async () => {
    await processor()(command({ pixels: [{ x: 0, y: 0, color: 2 }] }));
    const result = await processor()(command({ occurred_at: new Date(now - 1000).toISOString() }));
    expect(result).toMatchObject({ applied_pixels: 0, ignored_pixels: 1 });
    expect((await ref(`tile_colors/${tileId(1, 0, 0)}`).get()).get('colors')[locatePixel(0, 0).index]).toBe(2);
    expect((await ref('users/123456789012345678').get()).get('used_pixels')).toBe(2);
  });

  it('converges on the same pixel under concurrent writes with equal dates', async () => {
    const low = command({ event_id: '00000000-0000-4000-8000-000000000001' });
    const high = command({ event_id: '00000000-0000-4000-8000-000000000002', pixels: [{ x: 0, y: 0, color: 3 }] });
    await Promise.all([processor()(high), processor()(low)]);
    expect((await ref(`tile_colors/${tileId(1, 0, 0)}`).get()).get('colors')[0]).toBe(3);
    expect((await ref('users/123456789012345678').get()).get('used_pixels')).toBe(2);
  });

  it('replays the original result after a canvas clear without drawing in the new version', async () => {
    const input = command();
    const original = await processor()(input);
    await ref('config/global').update({ canvas_version: 2, bounds: null });
    expect(await processor()(input)).toEqual(original);
    expect((await ref(`tile_colors/${tileId(2, 0, 0)}`).get()).exists).toBe(false);
  });

  it('rejects reuse of an event ID with different business content', async () => {
    const input = command();
    await processor()(input);
    await expect(processor()({ ...input, pixels: [{ x: 0, y: 0, color: 3 }] })).rejects.toMatchObject({ code: 'event_id_conflict' });
    expect((await ref('users/123456789012345678').get()).get('used_pixels')).toBe(1);
  });

  it('rejects a whole over-quota batch without writing tiles', async () => {
    await ref('config/global').update({ default_limit_per_minute: 1 });
    const result = await processor()(command({ pixels: [{ x: 0, y: 0, color: 1 }, { x: 1, y: 0, color: 2 }] }));
    expect(result).toMatchObject({ type: 'pixel-rejected', reason: 'rate_limit' });
    expect((await ref('users/123456789012345678').get()).exists).toBe(false);
    expect((await db.collection(`${root}/tile_colors`).get()).empty).toBe(true);
  });

  it('serializes concurrent quota use so only one draw fits the limit', async () => {
    await ref('config/global').update({ default_limit_per_minute: 1 });
    const results = await Promise.all([processor()(command()), processor()(command({ pixels: [{ x: 1, y: 0, color: 2 }] }))]);
    expect(results.map((r) => r.type).sort()).toEqual(['pixel-processed', 'pixel-rejected']);
    expect((await ref('users/123456789012345678').get()).get('used_pixels')).toBe(1);
  });

  it('persists a paused refusal and does not change it after resume', async () => {
    const input = command();
    await ref('config/global').update({ paused: true });
    const result = await processor()(input);
    expect(result.reason).toBe('paused');
    await ref('config/global').update({ paused: false });
    expect(await processor()(input)).toEqual(result);
    expect((await processor()(command())).type).toBe('pixel-processed');
  });

  it('fails without partial writes when configuration is corrupt', async () => {
    await ref('config/global').update({ canvas_version: 0 });
    await expect(processor()(command())).rejects.toMatchObject({ code: 'invalid_state' });
    expect((await db.collection(`${root}/processed_events`).get()).empty).toBe(true);
    expect((await db.collection(`${root}/users`).get()).empty).toBe(true);
  });

  it('rejects expired commands with no remaining dedup record', async () => {
    const result = await processor()(command({ occurred_at: new Date(now - MAX_DRAW_AGE_MS - 1).toISOString() }));
    expect(result.reason).toBe('expired');
    expect((await db.collection(`${root}/tile_colors`).get()).empty).toBe(true);
  });

  it('still uses a logically expired dedup record until TTL actually deletes it', async () => {
    const input = command();
    const original = await processor()(input);
    const later = createDrawProcessor(db, { root, now: () => now + RESULT_RETENTION_MS + 1 });
    expect(await later(input)).toEqual(original);
    expect((await ref('users/123456789012345678').get()).get('used_pixels')).toBe(1);
  });

  it('retries publication from the stored result without drawing or charging twice', async () => {
    const input = command();
    const publish = vi.fn().mockRejectedValueOnce(new Error('temporary outage')).mockResolvedValueOnce(undefined);
    await expect(processAndPublishDraw(processor(), publish, input)).rejects.toThrow('temporary outage');
    const result = await processAndPublishDraw(processor(), publish, input);
    expect(publish).toHaveBeenNthCalledWith(1, result);
    expect(publish).toHaveBeenNthCalledWith(2, result);
    expect((await ref('users/123456789012345678').get()).get('used_pixels')).toBe(1);
  });
});
