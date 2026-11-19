import { randomUUID } from 'node:crypto';
import type { HttpFunction } from '@google-cloud/functions-framework';
import { PubSub, type Message } from '@google-cloud/pubsub';
import { expect, it, vi } from 'vitest';
import { createCommandWorkerHandler } from '../functions/command-worker/src/index';
import { createEventPublisher } from '../functions/command-worker/src/publisher';
import { commandPush, commandSubscription, noAdmins } from './command-worker-fixtures';
import { testApplication } from './discord-proxy-fixtures';
import { testProjectId } from './emulator-environment';

it('publishes retried draw commands to the local broker with an identical business ID', async () => {
  const client = new PubSub({ projectId: testProjectId });
  const topicName = `test-pixel-draw-${randomUUID()}`;
  const topic = client.topic(topicName);
  const subscription = topic.subscription(`test-draw-consumer-${randomUUID()}`);
  const messages: Message[] = [];
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await topic.create(); await subscription.create();
    const received = new Promise<void>((resolve, reject) => {
      timeout = setTimeout(() => reject(new Error('No routed messages received')), 10_000);
      subscription.once('error', reject);
      subscription.on('message', (message: Message) => {
        message.ack(); messages.push(message);
        if (messages.length === 2) { clearTimeout(timeout); resolve(); }
      });
    });
    void received.catch(() => undefined);
    const write = vi.fn();
    const handler = createCommandWorkerHandler({
      applicationId: testApplication, subscription: commandSubscription, permissions: noAdmins, write,
      publish: createEventPublisher(testProjectId, { 'pixel-draw': topicName }, client),
    });
    for (const messageId of ['123', '456']) {
      const body = commandPush(); body.message.messageId = messageId;
      const res = { status: vi.fn(), json: vi.fn(), send: vi.fn(), set: vi.fn() };
      res.status.mockReturnValue(res); res.set.mockReturnValue(res);
      await handler({ path: '/', method: 'POST', body, rawBody: Buffer.from(JSON.stringify(body)) } as Parameters<HttpFunction>[0],
        res as unknown as Parameters<HttpFunction>[1]);
      expect(res.status).toHaveBeenCalledWith(204);
    }
    await received;
    const [first, second] = messages.map((message) => JSON.parse(message.data.toString()));
    expect(first).toEqual(second);
    expect(first).toMatchObject({ type: 'pixel-draw', source: 'discord', payload: { pixels: [{ x: -1, y: 64, color: 3 }] } });
    for (const message of messages) {
      expect(message.attributes).toEqual(commandPush().message.attributes);
      expect(JSON.stringify(message.attributes)).not.toContain('synthetic-interaction-token');
    }
    expect(JSON.stringify(write.mock.calls)).not.toContain('synthetic-interaction-token');
  } finally {
    clearTimeout(timeout);
    await subscription.close();
    await subscription.delete().catch((error: { code?: number }) => { if (error.code !== 5) throw error; });
    await topic.delete().catch((error: { code?: number }) => { if (error.code !== 5) throw error; });
    await client.close();
  }
});
