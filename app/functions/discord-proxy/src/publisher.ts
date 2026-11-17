import { PubSub } from '@google-cloud/pubsub';
import type { DiscordCommandEvent } from './event';

export type PublishCommand = (event: DiscordCommandEvent, attributes: Record<string, string>) => Promise<unknown>;

export function createCommandPublisher(projectId: string, topicName: string, client?: PubSub): PublishCommand {
  // No network client until the first command; PING never initializes Pub/Sub.
  let topic: ReturnType<PubSub['topic']> | undefined;
  return async (event, attributes) => {
    topic ??= (client ?? new PubSub({ projectId })).topic(topicName, {
      batching: { maxMessages: 1 },
      gaxOpts: { timeout: 1000, retry: null },
    });
    return topic.publishMessage({ data: Buffer.from(JSON.stringify(event)), attributes });
  };
}
