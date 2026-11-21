import { PubSub } from '@google-cloud/pubsub';
import type { WebDrawEvent } from './request';

export type PublishDraw = (event: WebDrawEvent, attributes: Record<string, string>) => Promise<unknown>;

export function createDrawPublisher(projectId: string, topicName: string, client?: PubSub): PublishDraw {
  // No network client before the first valid draw: preflights and refusals never initialize Pub/Sub.
  // ADR-0014: a stroke is up to 500 messages; client batching shares publish requests between
  // them, each message staying a distinct event, acknowledged and retried alone by the broker.
  let topic: ReturnType<PubSub['topic']> | undefined;
  return async (event, attributes) => {
    topic ??= (client ?? new PubSub({ projectId })).topic(topicName, {
      batching: { maxMessages: 100, maxMilliseconds: 10 },
      gaxOpts: { timeout: 5000, retry: null },
    });
    return topic.publishMessage({ data: Buffer.from(JSON.stringify(event)), attributes });
  };
}
