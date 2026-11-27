import { randomUUID } from 'node:crypto';
import { Firestore } from '@google-cloud/firestore';
import { PubSub, type Message } from '@google-cloud/pubsub';
import type { HttpFunction } from '@google-cloud/functions-framework';
import { createDrawProcessor, createGroupCommit, createGroupDrawProcessor } from '@pixelwar/shared/drawing';
import type { DrawResultEvent, PixelDrawEvent } from '@pixelwar/shared/events';
import { tileId } from '@pixelwar/shared/grid';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDrawWorkerHandler } from '../functions/draw-worker/src/index';
import { createResultPublisher, type PublishResult } from '../functions/draw-worker/src/publisher';
import { discordDrawEvent, drawNow, drawPush, drawSubscription, webDrawEvent } from './draw-worker-fixtures';
import { testApplication, testNow } from './discord-proxy-fixtures';
import { testProjectId } from './emulator-environment';

const db = new Firestore({ projectId: testProjectId });
const client = new PubSub({ projectId: testProjectId });
const topics = [client.topic(`test-pixel-processed-${randomUUID()}`), client.topic(`test-pixel-rejected-${randomUUID()}`)];
const subscriptions = topics.map((topic) => topic.subscription(`test-result-consumer-${randomUUID()}`));
const received: { message: Message; event: DrawResultEvent }[] = [];
const roots: string[] = [];
let root: string;
let publish: PublishResult;
let error: unknown;
const ref = (path: string) => db.doc(`${root}/${path}`);
const command = (): PixelDrawEvent => ({ ...webDrawEvent(), event_id: randomUUID(), correlation_id: randomUUID() });
const resultsFor = async (event: PixelDrawEvent, count = 1) => {
  await vi.waitFor(() => {
    if (error) throw error;
    expect(received.filter((item) => item.event.payload.result.event_id === event.event_id)).toHaveLength(count);
  }, { timeout: 10_000, interval: 20 });
  return received.filter((item) => item.event.payload.result.event_id === event.event_id);
};
beforeAll(async () => {
  for (let i = 0; i < topics.length; i++) {
    await topics[i].create(); await subscriptions[i].create();
    subscriptions[i].on('error', (failure) => { error = failure; });
    subscriptions[i].on('message', (message: Message) => {
      message.ack(); received.push({ message, event: JSON.parse(message.data.toString()) });
    });
  }
  // The adapter intentionally accepts short topic IDs, not arbitrary resource URLs.
  publish = createResultPublisher(testProjectId, {
    'pixel-processed': topics[0].name.split('/').at(-1), 'pixel-rejected': topics[1].name.split('/').at(-1),
  }, client);
});
beforeEach(async () => {
  root = `draw_worker_tests/${randomUUID()}`; roots.push(root);
  await ref('config/global').set({ paused: false, canvas_version: 1, size: null, bounds: null, default_limit_per_minute: 20 });
});
afterAll(async () => {
  try {
    for (const subscription of subscriptions) {
      await subscription.close();
      await subscription.delete().catch((failure: { code?: number }) => { if (failure.code !== 5) throw failure; });
    }
    for (const topic of topics) await topic.delete().catch((failure: { code?: number }) => { if (failure.code !== 5) throw failure; });
    for (const path of roots) await db.recursiveDelete(db.doc(path));
  } finally { await client.close(); await db.terminate(); }
});

function handler(output = publish, now = drawNow, grouped = false) {
  const write = vi.fn();
  const single = createDrawProcessor(db, { root, now: () => now });
  const process = grouped
    ? createGroupCommit(single, createGroupDrawProcessor(db, { root, now: () => now }), { max_group: 32 }) : single;
  const handle = createDrawWorkerHandler({ subscription: drawSubscription, applicationId: testApplication,
    process, publish: output, write });
  const invoke = async (event: PixelDrawEvent, messageId = '123') => {
    const body = drawPush(event); body.message.messageId = messageId;
    const res = { status: vi.fn(), json: vi.fn(), send: vi.fn(), set: vi.fn() };
    res.status.mockReturnValue(res); res.set.mockReturnValue(res);
    await handle({ path: '/', method: 'POST', body, rawBody: Buffer.from(JSON.stringify(body)) } as Parameters<HttpFunction>[0],
      res as unknown as Parameters<HttpFunction>[1]);
    return res;
  };
  return { invoke, write };
}

describe('draw-worker with real local Firestore and Pub/Sub', () => {
  it('deduplicates simultaneous input deliveries and republishes the same durable result', async () => {
    const event = command(); const { invoke } = handler();
    const responses = await Promise.all([invoke(event, '123'), invoke(event, '456')]);
    for (const res of responses) expect(res.status).toHaveBeenCalledWith(204);
    const results = await resultsFor(event, 2);
    expect(results[0].event).toEqual(results[1].event);
    expect((await ref(`users/${event.actor.uid}`).get()).get('used_pixels')).toBe(1);
    expect((await db.collection(`${root}/deltas`).get()).size).toBe(1);
    expect(results[0].message.attributes.correlation_id).toBe(drawPush(event).message.attributes.correlation_id);
    expect(results[0].message.attributes.traceparent.split('-')[1]).toBe(drawPush(event).message.attributes.traceparent.split('-')[1]);
  });
  it('does not let a late message overwrite a newer pixel', async () => {
    const newer = command(); const older = command(); older.occurred_at = new Date(drawNow - 1000).toISOString();
    older.payload.pixels = [{ x: 0, y: 0, color: 3 }];
    const { invoke } = handler();
    expect((await invoke(newer)).status).toHaveBeenCalledWith(204);
    expect((await invoke(older)).status).toHaveBeenCalledWith(204);
    expect((await resultsFor(older))[0].event.payload.result).toMatchObject({ applied_pixels: 0, ignored_pixels: 1 });
    expect((await ref(`tile_colors/${tileId(1, 0, 0)}`).get()).get('colors')[0]).toBe(2);
  });
  it('publishes a paused refusal, then accepts a new draw after resume', async () => {
    const paused = command(); const { invoke } = handler();
    await ref('config/global').update({ paused: true });
    expect((await invoke(paused)).status).toHaveBeenCalledWith(204);
    expect((await resultsFor(paused))[0].event).toMatchObject({ type: 'pixel-rejected', payload: { result: { reason: 'paused' } } });
    expect((await ref(`users/${paused.actor.uid}`).get()).data()).toMatchObject({ used_pixels: 0, last_rejection: { reason: 'paused' } });
    await ref('config/global').update({ paused: false });
    const fresh = command(); expect((await invoke(fresh)).status).toHaveBeenCalledWith(204);
    expect((await resultsFor(fresh))[0].event.type).toBe('pixel-processed');
  });
  it('rejects an out-of-bounds pixel then accepts a NEW request on an infinite canvas', async () => {
    await ref('config/global').update({ size: { width: 10_000, height: 10_000 } });
    const outside = command(); outside.payload.pixels = [{ x: 10_000, y: 0, color: 2 }];
    const { invoke } = handler();
    expect((await invoke(outside)).status).toHaveBeenCalledWith(204);
    expect((await resultsFor(outside))[0].event.payload.result.reason).toBe('out_of_bounds');
    await ref('config/global').update({ size: null });
    const fresh = { ...outside, event_id: randomUUID() };
    expect((await invoke(fresh)).status).toHaveBeenCalledWith(204);
    expect((await resultsFor(fresh))[0].event.type).toBe('pixel-processed');
  });
  it('evaluates the quota pixel by pixel (ADR-0014): the pixel above the limit alone is rejected', async () => {
    await ref('config/global').update({ default_limit_per_minute: 1 });
    const first = command(); first.payload.pixels = [{ x: 0, y: 0, color: 2 }];
    const second = command(); second.payload.pixels = [{ x: 1, y: 0, color: 3 }];
    expect((await handler().invoke(first)).status).toHaveBeenCalledWith(204);
    expect((await handler().invoke(second)).status).toHaveBeenCalledWith(204);
    expect((await resultsFor(first))[0].event.type).toBe('pixel-processed');
    expect((await resultsFor(second))[0].event.payload.result.reason).toBe('rate_limit');
    expect((await db.collection(`${root}/tile_colors`).get()).size).toBe(1);
    expect((await ref(`users/${first.actor.uid}`).get()).get('used_pixels')).toBe(1);
  });
  it('groups a burst of concurrent pushes (ADR-0014): one result per pixel, exact quota, fewer transactions', async () => {
    await ref('config/global').update({ default_limit_per_minute: 30 });
    const stroke = Array.from({ length: 40 }, (_, x) => { const event = command(); event.payload.pixels = [{ x, y: 0, color: 2 }]; return event; });
    const { invoke } = handler(publish, drawNow, true);
    const responses = await Promise.all(stroke.map((event, index) => invoke(event, String(1000 + index))));
    for (const res of responses) expect(res.status).toHaveBeenCalledWith(204);
    const results = (await Promise.all(stroke.map((event) => resultsFor(event)))).flat();
    expect(results.filter((r) => r.event.type === 'pixel-processed')).toHaveLength(30);
    expect(results.filter((r) => r.event.payload.result.reason === 'rate_limit')).toHaveLength(10);
    expect((await ref(`users/${stroke[0].actor.uid}`).get()).get('used_pixels')).toBe(30);
    // The first push runs alone, the others share a few transactions: far fewer deltas than pixels.
    expect((await db.collection(`${root}/deltas`).get()).size).toBeLessThan(10);
  });
  it('refuses a message that carries several pixels, before any Firestore write', async () => {
    const event = command(); event.payload.pixels = [{ x: 0, y: 0, color: 2 }, { x: 1, y: 0, color: 3 }];
    expect((await handler().invoke(event)).status).toHaveBeenCalledWith(400);
    expect((await db.collection(`${root}/tile_colors`).get()).empty).toBe(true);
  });
  it.each([false, true])('recovers a publication outage after commit (uncertain success: %s)', async (uncertain) => {
    const event = command(); let first = true;
    const output: PublishResult = async (result, attrs) => {
      if (first) { first = false; if (uncertain) await publish(result, attrs); throw new Error('synthetic-secret'); }
      return publish(result, attrs);
    };
    const { invoke, write } = handler(output);
    const firstResponse = await invoke(event); expect(firstResponse.status).toHaveBeenCalledWith(503); expect(firstResponse.send).not.toHaveBeenCalled();
    expect((await ref(`users/${event.actor.uid}`).get()).get('used_pixels')).toBe(1);
    expect((await invoke(event, '456')).status).toHaveBeenCalledWith(204);
    const results = await resultsFor(event, uncertain ? 2 : 1);
    expect(results.every((r) => JSON.stringify(r.event) === JSON.stringify(results[0].event))).toBe(true);
    expect((await ref(`users/${event.actor.uid}`).get()).get('used_pixels')).toBe(1);
    expect(JSON.stringify(write.mock.calls)).not.toContain('synthetic-secret');
  });
  it('routes a real BOT-04 Discord event and carries its token only for the notifier', async () => {
    const event = discordDrawEvent(); const { invoke, write } = handler(publish, testNow);
    expect((await invoke(event)).status).toHaveBeenCalledWith(204);
    const [result] = await resultsFor(event);
    expect(result.event.source).toBe('discord');
    expect(result.event.payload.discord?.interaction_token).toBe('synthetic-interaction-token');
    expect(JSON.stringify(result.message.attributes)).not.toContain('synthetic-interaction-token');
    expect(JSON.stringify(write.mock.calls)).not.toContain('synthetic-interaction-token');
    expect(JSON.stringify((await ref(`processed_events/${event.event_id}`).get()).data())).not.toContain('synthetic-interaction-token');
  });
  it('retries a corrupt/missing configuration without committing a partial draw', async () => {
    const event = command(); await ref('config/global').delete();
    const res = await handler().invoke(event);
    expect(res.status).toHaveBeenCalledWith(503);
    expect((await db.collection(`${root}/processed_events`).get()).empty).toBe(true);
    expect((await db.collection(`${root}/tile_colors`).get()).empty).toBe(true);
  });

  it('quarantines a malformed batch through DATA-02 validation without writing it', async () => {
    const event = command(); event.payload.pixels = [{ x: 0.5, y: 0, color: 2 }];
    expect((await handler().invoke(event)).status).toHaveBeenCalledWith(400);
    expect((await db.collection(`${root}/processed_events`).get()).empty).toBe(true);
    expect((await db.collection(`${root}/users`).get()).empty).toBe(true);
  });
});
