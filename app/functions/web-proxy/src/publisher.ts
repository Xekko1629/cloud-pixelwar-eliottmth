import { PubSub } from '@google-cloud/pubsub';
import type { WebDrawEvent } from './request';

export type PublishDraw = (event: WebDrawEvent, attributes: Record<string, string>) => Promise<unknown>;

export function createDrawPublisher(projectId: string, topicName: string, client?: PubSub): PublishDraw {
  // No network client before the first valid draw: preflights and refusals never initialize Pub/Sub.
  let topic: ReturnType<PubSub['topic']> | undefined;
  return async (event, attributes) => {
    topic ??= (client ?? new PubSub({ projectId })).topic(topicName, {
      batching: { maxMessages: 1 },
      gaxOpts: { timeout: 5000, retry: null },
    });
    return topic.publishMessage({ data: Buffer.from(JSON.stringify(event)), attributes });
  };
}
