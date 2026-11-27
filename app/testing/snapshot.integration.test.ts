import { randomUUID } from 'node:crypto';
import { Firestore } from '@google-cloud/firestore';
import type { HttpFunction } from '@google-cloud/functions-framework';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { snowflakeTime } from '@pixelwar/shared/discord';
import { createDrawProcessor } from '@pixelwar/shared/drawing';
import { SNAPSHOT_RENDER_OPTIONS } from '@pixelwar/shared/render';
import { createFirestoreRenderStore, renderCanvas } from '@pixelwar/shared/render/canvas';
import { requestObjectName, snapshotEventId } from '@pixelwar/shared/snapshot';
import { createSnapshotNotifierHandler } from '../functions/snapshot-notifier/src/index';
import { createSnapshotWorkerHandler } from '../functions/snapshot-worker/src/index';
import { eventPush, routedCommand } from './admin-worker-fixtures';
import { testApplication } from './discord-proxy-fixtures';
import { testProjectId } from './emulator-environment';
import { decodePng } from './png-reader';
import { finalizePush, snapshotReadySubscription, snapshotSubscription, snapshotsBucket } from './snapshot-fixtures';

const db = new Firestore({ projectId: testProjectId });
const roots: string[] = [];
let root: string;
const call = async (handler: HttpFunction, body: unknown) => {
  const res = { status: vi.fn(), json: vi.fn(), send: vi.fn(), set: vi.fn() };
  res.status.mockReturnValue(res); res.set.mockReturnValue(res);
  await handler({ path: '/', method: 'POST', body, rawBody: Buffer.from(JSON.stringify(body)) } as unknown as Parameters<HttpFunction>[0],
    res as unknown as Parameters<HttpFunction>[1]);
  return res;
};

beforeEach(async () => {
  root = `snapshot_tests/${randomUUID()}`; roots.push(root);
  await db.doc(`${root}/config/global`).set({ paused: false, canvas_version: 1, size: null, bounds: null, default_limit_per_minute: 20 });
});
afterAll(async () => {
  try { for (const path of roots) await db.recursiveDelete(db.doc(path)); }
  finally { await db.terminate(); }
});

describe('/snapshot from the routed command to the posted link (BOT-07a/b)', () => {
  it('renders the real drawing, stores it with its request, then posts a signed URL in the deferred answer', async () => {
    const routed = routedCommand('snapshot', {});
    const created = snowflakeTime((routed.payload as { discord: { interaction_id: string } }).discord.interaction_id);
    await createDrawProcessor(db, { root, now: () => created })({
      event_id: randomUUID(), occurred_at: new Date(created).toISOString(), source: 'web',
      author: { uid: '123456789012345678', name: 'Test user' }, pixels: [{ x: 3, y: 1, color: 5 }],
    });

    const objects = new Map<string, Uint8Array>();
    const store = createFirestoreRenderStore(db, { root });
    const worker = createSnapshotWorkerHandler({
      applicationId: testApplication, subscription: snapshotSubscription, write: vi.fn(), now: () => created + 1000, edit: vi.fn(),
      render: () => renderCanvas(store, SNAPSHOT_RENDER_OPTIONS),
      create: async (name, data) => { if (objects.has(name)) return false; objects.set(name, data); return true; },
    });
    expect((await call(worker, eventPush(routed, snapshotSubscription))).status).toHaveBeenCalledWith(204);
    const imageName = [...objects.keys()].find((name) => snapshotEventId(name) === routed.event_id)!;
    const png = decodePng(Buffer.from(objects.get(imageName)!));
    expect(png.width).toBe(1); expect(png.height).toBe(1); // Only the painted rectangle, here one pixel.

    const edit = vi.fn().mockResolvedValue('updated');
    const notifier = createSnapshotNotifierHandler({
      applicationId: testApplication, subscription: snapshotReadySubscription, bucket: snapshotsBucket, write: vi.fn(), now: () => created + 2000, edit,
      readRequest: async (eventId) => JSON.parse(Buffer.from(objects.get(requestObjectName(eventId))!).toString()),
      sign: async (object) => `https://storage.example.test/${object}?X-Goog-Signature=abc`,
    });
    expect((await call(notifier, finalizePush(imageName))).status).toHaveBeenCalledWith(204);
    expect(edit).toHaveBeenCalledWith(expect.objectContaining({ interaction_token: 'synthetic-interaction-token', created_at: created }),
      expect.objectContaining({ content: expect.stringContaining(`https://storage.example.test/${imageName}`) }));
  });
});
