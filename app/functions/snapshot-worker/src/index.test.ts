import { describe, expect, it, vi } from 'vitest';
import type { HttpFunction } from '@google-cloud/functions-framework';
import type { Storage } from '@google-cloud/storage';
import { NotificationFailure, snowflakeTime, TOKEN_LIFETIME_MS, textResponse } from '@pixelwar/shared/discord';
import { StoredDataError, type RenderResult } from '@pixelwar/shared/render/canvas';
import { parseSnapshotRequest, requestObjectName, snapshotEventId } from '@pixelwar/shared/snapshot';
import { eventPush, routedCommand } from '../../../testing/admin-worker-fixtures';
import { testApplication } from '../../../testing/discord-proxy-fixtures';
import { snapshotSubscription } from '../../../testing/snapshot-fixtures';
import { EMPTY_MESSAGE, TOO_LARGE_MESSAGE, createBucketWriter, createSnapshotWorkerHandler, handleSnapshotWorker } from './index';

const routed = routedCommand('snapshot', {});
const created = snowflakeTime((routed.payload as { discord: { interaction_id: string } }).discord.interaction_id);
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const image: RenderResult = { kind: 'image', canvas_version: 2,
  image: { png, width: 71, height: 4, scale: 1, area: { min_x: 0, min_y: 0, max_x: 70, max_y: 3 } } };

function setup(overrides: Record<string, unknown> = {}) {
  const objects = new Map<string, { data: Uint8Array; contentType: string; metadata?: Record<string, string> }>();
  const order: string[] = [];
  const create = vi.fn(async (name: string, data: Uint8Array, contentType: string, metadata?: Record<string, string>) => {
    order.push(name);
    if (objects.has(name)) return false;
    objects.set(name, { data, contentType, metadata }); return true;
  });
  const render = vi.fn().mockResolvedValue(image);
  const edit = vi.fn().mockResolvedValue('updated');
  const write = vi.fn();
  const handler = createSnapshotWorkerHandler({ applicationId: testApplication, subscription: snapshotSubscription,
    render, create, edit, write, now: () => created + 2000, ...overrides });
  const invoke = async (body: unknown = eventPush(routed, snapshotSubscription)) => {
    const res = { status: vi.fn(), json: vi.fn(), send: vi.fn(), set: vi.fn() };
    res.status.mockReturnValue(res); res.set.mockReturnValue(res);
    await handler({ path: '/', method: 'POST', body, rawBody: Buffer.from(JSON.stringify(body)) } as unknown as Parameters<HttpFunction>[0],
      res as unknown as Parameters<HttpFunction>[1]);
    return res;
  };
  const logs = () => write.mock.calls.map(([line]) => JSON.parse(line));
  return { render, edit, create, objects, order, write, invoke, logs };
}

describe('snapshot-worker (BOT-07a)', () => {
  it('stores the request, then the timestamped image, and leaves the answer to the notifier', async () => {
    const { invoke, objects, order, edit, logs } = setup();
    expect((await invoke()).status).toHaveBeenCalledWith(204);
    expect(order).toHaveLength(2);
    expect(order[0]).toBe(requestObjectName(routed.event_id));
    expect(snapshotEventId(order[1])).toBe(routed.event_id);
    expect(order[1]).toContain(new Date(created).toISOString().replace(/[:.]/g, '-'));
    const request = parseSnapshotRequest(JSON.parse(Buffer.from(objects.get(order[0])!.data).toString()));
    expect(request).toMatchObject({ event_id: routed.event_id, application_id: testApplication, interaction_token: 'synthetic-interaction-token', created_at: created });
    expect(objects.get(order[1])).toEqual({ data: png, contentType: 'image/png', metadata: { event_id: routed.event_id, canvas_version: '2' } });
    expect(edit).not.toHaveBeenCalled();
    expect(logs().some((line) => line.event_type === 'snapshot.stored')).toBe(true);
  });

  it('never puts the token in the image metadata nor in the logs', async () => {
    const { invoke, objects, write } = setup();
    await invoke();
    const imageObject = [...objects].find(([name]) => name.endsWith('.png'))![1];
    expect(JSON.stringify(imageObject.metadata)).not.toContain('synthetic-interaction-token');
    expect(JSON.stringify(write.mock.calls)).not.toContain('synthetic-interaction-token');
  });

  it('creates nothing twice when the request is delivered again', async () => {
    const { invoke, objects, logs } = setup();
    await invoke(); expect((await invoke()).status).toHaveBeenCalledWith(204);
    expect(objects.size).toBe(2);
    expect(logs().some((line) => line.event_type === 'snapshot.already_stored')).toBe(true);
  });

  it.each<[RenderResult, string, string]>([
    [{ kind: 'empty' }, EMPTY_MESSAGE, 'snapshot.empty'], [{ kind: 'too_large', cells: 70_000 }, TOO_LARGE_MESSAGE, 'snapshot.too_large'],
  ])('answers directly when there is no image to store: %j', async (result, message, eventType) => {
    const { invoke, objects, edit, logs } = setup({ render: vi.fn().mockResolvedValue(result) });
    expect((await invoke()).status).toHaveBeenCalledWith(204);
    expect(objects.size).toBe(0);
    expect(edit).toHaveBeenCalledWith(expect.objectContaining({ interaction_token: 'synthetic-interaction-token' }), textResponse(message));
    expect(logs().some((line) => line.event_type === eventType)).toBe(true);
  });

  it('skips the render once the interaction token has expired', async () => {
    const { invoke, render, objects } = setup({ now: () => created + TOKEN_LIFETIME_MS });
    expect((await invoke()).status).toHaveBeenCalledWith(204);
    expect(render).not.toHaveBeenCalled(); expect(objects.size).toBe(0);
  });

  it.each([
    [new StoredDataError('bad'), 'stored_data'], [new NotificationFailure('http', 500), 'http'], [new Error('synthetic-interaction-token'), undefined],
  ])('asks for a retry on a technical failure, without leaking it', async (error, reason) => {
    const failing = vi.fn().mockRejectedValue(error);
    const { invoke, write, logs } = setup(error instanceof NotificationFailure
      ? { render: vi.fn().mockResolvedValue({ kind: 'empty' }), edit: failing } : { render: failing });
    expect((await invoke()).status).toHaveBeenCalledWith(503);
    expect(logs().at(-1)).toMatchObject({ severity: 'ERROR', event_type: 'snapshot.failed', ...(reason ? { reason } : {}) });
    expect(JSON.stringify(write.mock.calls)).not.toContain('synthetic-interaction-token');
  });

  it('quarantines another event type (400, then DLQ)', async () => {
    const { invoke, logs } = setup();
    expect((await invoke(eventPush(routedCommand('get', {}), snapshotSubscription))).status).toHaveBeenCalledWith(400);
    expect(logs()[0]).toMatchObject({ event_type: 'snapshot.message.invalid', reason: 'invalid_event' });
  });

  it('answers 503 without configuration and refuses other paths, methods and sizes', async () => {
    const { invoke } = setup({ create: undefined });
    expect((await invoke()).status).toHaveBeenCalledWith(503);
    const res = { status: vi.fn(), json: vi.fn(), set: vi.fn() }; res.status.mockReturnValue(res); res.set.mockReturnValue(res);
    await handleSnapshotWorker({ path: '/', method: 'POST' } as Parameters<HttpFunction>[0], res as unknown as Parameters<HttpFunction>[1]);
    expect(res.status).toHaveBeenCalledWith(503);
    const handler = createSnapshotWorkerHandler({ applicationId: testApplication, subscription: snapshotSubscription,
      render: vi.fn(), create: vi.fn(), edit: vi.fn(), write: vi.fn() });
    for (const [request, status] of [[{ path: '/x', method: 'POST' }, 404], [{ path: '/', method: 'GET' }, 405],
      [{ path: '/', method: 'POST', rawBody: Buffer.alloc(200 * 1024) }, 413]] as const) {
      const r = { status: vi.fn(), json: vi.fn(), set: vi.fn() }; r.status.mockReturnValue(r); r.set.mockReturnValue(r);
      await handler(request as unknown as Parameters<HttpFunction>[0], r as unknown as Parameters<HttpFunction>[1]);
      expect(r.status).toHaveBeenCalledWith(status);
    }
  });
});

describe('createBucketWriter', () => {
  function storage(save: ReturnType<typeof vi.fn>) {
    const file = vi.fn(() => ({ save }));
    return { storage: { bucket: vi.fn(() => ({ file })) } as unknown as Storage, file };
  }
  it('creates an object only if it does not exist, with its metadata', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const { storage: client, file } = storage(save);
    expect(await createBucketWriter(client, 'b')('snapshots/a.png', Uint8Array.of(1), 'image/png', { event_id: 'e' })).toBe(true);
    expect(file).toHaveBeenCalledWith('snapshots/a.png');
    expect(save).toHaveBeenCalledWith(Buffer.from([1]), {
      resumable: false, contentType: 'image/png', preconditionOpts: { ifGenerationMatch: 0 }, metadata: { metadata: { event_id: 'e' } },
    });
    await createBucketWriter(client, 'b')('requests/a.json', Uint8Array.of(2), 'application/json');
    expect(save.mock.calls[1][1]).not.toHaveProperty('metadata');
  });
  it('reports an existing object (412) and propagates other failures', async () => {
    const exists = storage(vi.fn().mockRejectedValue(Object.assign(new Error('Precondition'), { code: 412 })));
    expect(await createBucketWriter(exists.storage, 'b')('x', Uint8Array.of(1), 'image/png')).toBe(false);
    const denied = storage(vi.fn().mockRejectedValue(Object.assign(new Error('denied'), { code: 403 })));
    await expect(createBucketWriter(denied.storage, 'b')('x', Uint8Array.of(1), 'image/png')).rejects.toThrow('denied');
  });
});
