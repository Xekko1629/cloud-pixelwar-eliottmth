import { randomUUID } from 'node:crypto';
import { Firestore } from '@google-cloud/firestore';
import { PubSub, type Message, type Subscription } from '@google-cloud/pubsub';
import type { HttpFunction } from '@google-cloud/functions-framework';
import { createDrawProcessor } from '@pixelwar/shared/drawing';
import type { DrawResultEvent } from '@pixelwar/shared/events';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDiscordProxyHandler } from '../functions/discord-proxy/src/index';
import { commandEvent } from '../functions/discord-proxy/src/event';
import { createCommandPublisher } from '../functions/discord-proxy/src/publisher';
import { createCommandWorkerHandler } from '../functions/command-worker/src/index';
import { createEventPublisher } from '../functions/command-worker/src/publisher';
import { createDrawWorkerHandler } from '../functions/draw-worker/src/index';
import { createResultPublisher } from '../functions/draw-worker/src/publisher';
import { createDiscordNotifierHandler } from '../functions/discord-notifier/src/index';
import { createOriginalResponseUpdater } from '../functions/discord-notifier/src/discord';
import { TOKEN_LIFETIME_MS } from '../functions/discord-notifier/src/message';
import { drawInteraction, signedRequest, testApplication, testNow, testPublicKey } from './discord-proxy-fixtures';
import { noAdmins } from './command-worker-fixtures';
import { startFakeDiscord } from './fake-discord';
import { testProjectId } from './emulator-environment';
import { memoryTelemetry } from '../shared/testing/telemetry';

const db = new Firestore({ projectId: testProjectId });
const client = new PubSub({ projectId: testProjectId });
const names = ['command', 'draw', 'processed', 'rejected'].map((kind) => `test-pipeline-${kind}-${randomUUID()}`);
const topics = names.map((name) => client.topic(name));
const subscriptions = topics.map((topic) => topic.subscription(`test-pipeline-consumer-${randomUUID()}`));
const roots: string[] = [];
const inbox = new Map<Subscription, Message[]>();
let subscriptionError: Error | undefined;
const logs = vi.fn();
let telemetryNow = testNow + 2000;
const observers = {
  proxy: memoryTelemetry('discord-proxy', logs, () => telemetryNow),
  command: memoryTelemetry('command-worker', logs, () => telemetryNow),
  draw: memoryTelemetry('draw-worker', logs, () => telemetryNow),
  notifier: memoryTelemetry('discord-notifier', logs, () => telemetryNow),
};
let api: Awaited<ReturnType<typeof startFakeDiscord>>;
let root: string;
let serial = 0;
const ref = (path: string) => db.doc(`${root}/${path}`);
beforeAll(async () => {
  api = await startFakeDiscord();
  for (let i = 0; i < topics.length; i++) {
    await topics[i].create(); await subscriptions[i].create();
    inbox.set(subscriptions[i], []);
    subscriptions[i].on('error', (error) => { subscriptionError = error; });
    subscriptions[i].on('message', (message: Message) => { message.ack(); inbox.get(subscriptions[i])!.push(message); });
  }
});
beforeEach(async () => {
  root = `discord_pipeline_tests/${randomUUID()}`; roots.push(root);
  telemetryNow = testNow + 2000;
  api.requests.length = 0; api.messages.clear(); api.responses.length = 0; logs.mockClear();
  for (const observer of Object.values(observers)) { observer.spans.reset(); observer.metrics.reset(); }
  await ref('config/global').set({ paused: false, canvas_version: 1, size: null, bounds: null, default_limit_per_minute: 20 });
});
afterAll(async () => {
  try {
    for (const subscription of subscriptions) {
      await subscription.close();
      await subscription.delete().catch((error: { code?: number }) => { if (error.code !== 5) throw error; });
    }
    for (const topic of topics) await topic.delete().catch((error: { code?: number }) => { if (error.code !== 5) throw error; });
    for (const path of roots) await db.recursiveDelete(db.doc(path));
  } finally {
    await Promise.all(Object.values(observers).map((observer) => observer.runtime.shutdown()));
    if (api) await api.close(); await client.close(); await db.terminate();
  }
});

async function receive(subscription: Subscription, correlationId: string) {
  const messages = inbox.get(subscription)!;
  // Pub/Sub can redeliver or reorder: match this interaction, not the first arrival.
  await vi.waitFor(() => {
    if (subscriptionError) throw subscriptionError;
    expect(messages.some((message) => message.attributes.correlation_id === correlationId)).toBe(true);
  }, { timeout: 10_000, interval: 20 });
  return messages.splice(messages.findIndex((message) => message.attributes.correlation_id === correlationId), 1)[0];
}
function response() {
  const res = { status: vi.fn(), json: vi.fn(), send: vi.fn(), set: vi.fn() };
  res.status.mockReturnValue(res); res.set.mockReturnValue(res); return res;
}
async function push(handler: HttpFunction, subscription: Subscription, message: Message) {
  const body = { subscription: subscription.name, message: {
    messageId: message.id, data: message.data.toString('base64'), attributes: message.attributes,
  } };
  const res = response();
  await handler({ path: '/', method: 'POST', body, rawBody: Buffer.from(JSON.stringify(body)) } as Parameters<HttpFunction>[0],
    res as unknown as Parameters<HttpFunction>[1]);
  expect(res.status).toHaveBeenCalledWith(204);
  return res;
}
function interaction() {
  const value = drawInteraction(); value.id = String(BigInt(value.id) + BigInt(++serial)); return value;
}
async function pipeline(input: ReturnType<typeof drawInteraction>, expectedType: DrawResultEvent['type'] = 'pixel-processed', now = testNow + 2000) {
  telemetryNow = now;
  const correlationId = commandEvent(input, testApplication).correlation_id;
  const proxyResponse = response();
  await createDiscordProxyHandler({ publicKey: testPublicKey, applicationId: testApplication, now: () => testNow, log: logs,
    telemetry: observers.proxy.telemetry,
    publish: createCommandPublisher(testProjectId, topics[0].name, client) })(signedRequest(input), proxyResponse as unknown as Parameters<HttpFunction>[1]);
  expect(proxyResponse.json).toHaveBeenCalledWith({ type: 5 });

  await push(createCommandWorkerHandler({ applicationId: testApplication, subscription: subscriptions[0].name, permissions: noAdmins, write: logs,
    telemetry: observers.command.telemetry,
    publish: createEventPublisher(testProjectId, { 'pixel-draw': names[1] }, client) }), subscriptions[0], await receive(subscriptions[0], correlationId));

  const resultIndex = expectedType === 'pixel-processed' ? 2 : 3;
  await push(createDrawWorkerHandler({ applicationId: testApplication, subscription: subscriptions[1].name,
    telemetry: observers.draw.telemetry,
    process: createDrawProcessor(db, { root, now: () => testNow + 2000 }),
    publish: createResultPublisher(testProjectId, { 'pixel-processed': names[2], 'pixel-rejected': names[3] }, client), write: logs,
  }), subscriptions[1], await receive(subscriptions[1], correlationId));

  const message = await receive(subscriptions[resultIndex], correlationId);
  await push(createDiscordNotifierHandler({ applicationId: testApplication,
    telemetry: observers.notifier.telemetry,
    subscriptions: { 'pixel-processed': subscriptions[2].name, 'pixel-rejected': subscriptions[3].name },
    update: createOriginalResponseUpdater({ fetch: api.fetch, now: () => now }), write: logs,
  }), subscriptions[resultIndex], message);
  expect(JSON.stringify(logs.mock.calls)).not.toMatch(/synthetic-interaction-token|Synthetic user|webhooks/);
  expect(JSON.stringify(message.attributes)).not.toContain('synthetic-interaction-token');
  return JSON.parse(message.data.toString()) as DrawResultEvent;
}

describe('signed /draw to original-response update on local services', () => {
  it('runs the complete application path with real broker messages, a Firestore transaction and a local Discord PATCH', async () => {
    const result = await pipeline(interaction());
    expect(result.type).toBe('pixel-processed'); expect(api.messages.size).toBe(1);
    expect(api.requests[0].body).toMatchObject({ content: expect.stringContaining('Pixels appliqués : 1'), allowed_mentions: { parse: [] } });
    expect((await ref(`users/${result.actor.uid}`).get()).get('used_pixels')).toBe(1);
    expect(JSON.stringify((await ref(`processed_events/${result.payload.result.event_id}`).get()).data())).not.toContain('synthetic-interaction-token');
    const spans = Object.values(observers).map((observer) => observer.spans.getFinishedSpans()[0]);
    expect(spans.every(Boolean)).toBe(true);
    expect(new Set(spans.map((span) => span.spanContext().traceId)).size).toBe(1);
    for (let i = 1; i < spans.length; i++) expect(spans[i].parentSpanContext?.spanId).toBe(spans[i - 1].spanContext().spanId);
    const technicalFields = spans.map((span) => ({ name: span.name, attributes: span.attributes, events: span.events }));
    expect(JSON.stringify(technicalFields)).not.toMatch(/synthetic-interaction-token|webhooks|423456789012345678/);
    expect(JSON.stringify(logs.mock.calls)).toContain('logging.googleapis.com/trace');
    for (const observer of Object.values(observers)) {
      const metrics = observer.metrics.getMetrics().at(-1)!.scopeMetrics.flatMap((scope) => scope.metrics);
      expect(metrics.some((metric) => metric.descriptor.name === 'pixelwar.function.attempts')).toBe(true);
      for (const metric of metrics) for (const point of metric.dataPoints) {
        expect(Object.keys(point.attributes).every((key) => ['source', 'outcome', 'reason', 'category'].includes(key))).toBe(true);
      }
    }
  });
  it('replays the same interaction through the WHOLE pipeline with one draw, one quota charge and one visible message', async () => {
    const input = interaction(); const first = await pipeline(input); const second = await pipeline(input);
    expect(first).toEqual(second); expect(api.requests).toHaveLength(2); expect(api.messages.size).toBe(1);
    expect(api.requests[0]).toEqual(api.requests[1]);
    expect((await ref(`users/${first.actor.uid}`).get()).get('used_pixels')).toBe(1);
    expect((await db.collection(`${root}/deltas`).get()).size).toBe(1);
  });
  it.each([
    [{ paused: true }, 'paused', 'pause'],
    [{ default_limit_per_minute: 0 }, 'rate_limit', 'Quota dépassé'],
    [{ size: { width: 10_000, height: 10_000 } }, 'out_of_bounds', 'Coordonnées hors'],
  ] as const)('notifies a refusal through the same pipeline: %s', async (config, reason, text) => {
    await ref('config/global').update(config);
    const result = await pipeline(interaction(), 'pixel-rejected');
    expect(result.payload.result.reason).toBe(reason);
    expect(api.requests[0].body).toMatchObject({ content: expect.stringContaining(text) });
    expect((await db.collection(`${root}/tile_colors`).get()).empty).toBe(true);
  });
  it('keeps the successful draw but skips the notification once the token expires', async () => {
    const result = await pipeline(interaction(), 'pixel-processed', testNow + TOKEN_LIFETIME_MS);
    expect(api.requests).toHaveLength(0); expect(api.messages.size).toBe(0);
    expect((await ref(`users/${result.actor.uid}`).get()).get('used_pixels')).toBe(1);
    expect(JSON.stringify(logs.mock.calls)).toContain('discord.notification.expired');
    const metrics = observers.notifier.metrics.getMetrics().at(-1)!.scopeMetrics.flatMap((scope) => scope.metrics);
    expect(metrics.find((metric) => metric.descriptor.name === 'pixelwar.notification.age')!.dataPoints[0].value).toMatchObject({ max: 900 });
    const attempts = metrics.find((metric) => metric.descriptor.name === 'pixelwar.function.attempts')!.dataPoints;
    expect(attempts.some((point) => point.attributes.outcome === 'expired' && point.attributes.reason === 'expired')).toBe(true);
  });
  it('still completes the business path if telemetry export fails after the draw', async () => {
    const flush = vi.spyOn(observers.draw.runtime, 'flushRequest').mockRejectedValue(new Error('synthetic-interaction-token'));
    try {
      const result = await pipeline(interaction());
      expect((await ref(`users/${result.actor.uid}`).get()).get('used_pixels')).toBe(1);
      expect(api.requests).toHaveLength(1); expect(api.messages.size).toBe(1);
      expect(JSON.stringify(logs.mock.calls)).toContain('telemetry.flush_failed');
    } finally { flush.mockRestore(); }
  });
});
