import { randomUUID } from 'node:crypto';
import { PubSub, type Message } from '@google-cloud/pubsub';
import { expect, it } from 'vitest';
import { testProjectId } from './emulator-environment';

it('publishes, receives and acknowledges an emulator message', async () => {
  const pubsub = new PubSub({ projectId: testProjectId });
  const id = randomUUID();
  const topic = pubsub.topic(`test-foundation-${id}`);
  const subscription = topic.subscription(`test-foundation-${id}`);
  const correlationId = randomUUID();

  try {
    await topic.create();
    await subscription.create();
    const received = new Promise<Message>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('No emulator message received')), 10_000);
      subscription.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      subscription.once('message', (message: Message) => {
        clearTimeout(timeout);
        message.ack();
        resolve(message);
      });
    });
    // Attach a rejection handler immediately, even if publishing itself fails.
    void received.catch(() => undefined);
    await topic.publishMessage({ data: Buffer.from('test-foundation'), attributes: { correlation_id: correlationId } });
    const message = await received;
    expect(message.data.toString()).toBe('test-foundation');
    expect(message.attributes.correlation_id).toBe(correlationId);
  } finally {
    await subscription.close();
    await subscription.delete().catch((error: { code?: number }) => {
      if (error.code !== 5) throw error;
    });
    await topic.delete().catch((error: { code?: number }) => {
      if (error.code !== 5) throw error;
    });
    await pubsub.close();
  }
});
