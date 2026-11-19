import { PubSub } from '@google-cloud/pubsub';
import type { DrawResultEvent } from '@pixelwar/shared/events';
import type { Attributes } from './message';

export type PublishResult = (event: DrawResultEvent, attributes: Attributes) => Promise<unknown>;
export type ResultTopics = Partial<Record<DrawResultEvent['type'], string>>;
export function createResultPublisher(projectId: string, names: ResultTopics, client?: PubSub): PublishResult {
  const configured = { ...names };
  const topics = new Map<DrawResultEvent['type'], ReturnType<PubSub['topic']>>();
  let pubsub = client;
  return async (event, attributes) => {
    const name = configured[event.type];
    if (!name || !/^[a-zA-Z][a-zA-Z0-9._~+%-]{2,254}$/.test(name) || /^goog/i.test(name)) throw new Error('Result topic unavailable');
    let topic = topics.get(event.type);
    if (!topic) {
      pubsub ??= new PubSub({ projectId });
      topic = pubsub.topic(name, { batching: { maxMessages: 1 }, gaxOpts: { timeout: 5000, retry: null } });
      topics.set(event.type, topic);
    }
    return topic.publishMessage({ data: Buffer.from(JSON.stringify(event)), attributes });
  };
}
