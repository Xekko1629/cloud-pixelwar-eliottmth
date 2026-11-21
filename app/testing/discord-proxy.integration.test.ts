import { randomUUID } from 'node:crypto';
import { PubSub, type Message } from '@google-cloud/pubsub';
import type { HttpFunction } from '@google-cloud/functions-framework';
import { expect, it, vi } from 'vitest';
import { createDiscordProxyHandler } from '../functions/discord-proxy/src/index';
import { createCommandPublisher } from '../functions/discord-proxy/src/publisher';
import { drawInteraction, signedRequest, testApplication, testNow, testPublicKey } from './discord-proxy-fixtures';
import { testProjectId } from './emulator-environment';

it('publishes a signed /draw through the handler to the local Pub/Sub emulator before deferring', async () => {
  const client = new PubSub({ projectId: testProjectId });
  const topic = client.topic(`test-discord-command-${randomUUID()}`);
  const subscription = topic.subscription(`test-discord-consumer-${randomUUID()}`);
  try {
    await topic.create();
    await subscription.create();
    const received = new Promise<Message>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('No proxy message received')), 10_000);
      subscription.once('error', (error) => { clearTimeout(timeout); reject(error); });
      subscription.once('message', (message: Message) => { clearTimeout(timeout); message.ack(); resolve(message); });
    });
    void received.catch(() => undefined);
    const handler = createDiscordProxyHandler({
      publicKey: testPublicKey, applicationId: testApplication, now: () => testNow, log: vi.fn(),
      publish: createCommandPublisher(testProjectId, topic.name, client),
    });
    const res = { status: vi.fn(), json: vi.fn(), set: vi.fn() };
    res.status.mockReturnValue(res); res.set.mockReturnValue(res);
    await handler(signedRequest(drawInteraction()), res as unknown as Parameters<HttpFunction>[1]);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ type: 5 });
    const message = await received;
    const event = JSON.parse(message.data.toString());
    expect(event.payload).toMatchObject({ command: 'draw', options: { x: -1, y: 64, color: 3 } });
    expect(event.actor.uid).toBe('423456789012345678');
    expect(message.attributes.correlation_id).toBe(event.correlation_id);
    expect(message.attributes.traceparent).toMatch(/^00-[a-f0-9]{32}-[a-f0-9]{16}-0[01]$/);
    expect(JSON.stringify(message.attributes)).not.toContain('synthetic-interaction-token');
  } finally {
    await subscription.close();
    await subscription.delete().catch((error: { code?: number }) => { if (error.code !== 5) throw error; });
    await topic.delete().catch((error: { code?: number }) => { if (error.code !== 5) throw error; });
    await client.close();
  }
});
