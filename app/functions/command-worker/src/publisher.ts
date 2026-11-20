import { PubSub } from '@google-cloud/pubsub';
import type { OutputType, RoutedEvent } from './route';

export type PublishEvent = (event: RoutedEvent, attributes: { correlation_id: string; traceparent: string }) => Promise<unknown>;
export type Topics = Partial<Record<OutputType, string>>;

/** A configured route only; missing topics fail without acknowledging the source. */
export function createEventPublisher(projectId: string, names: Topics, client?: PubSub): PublishEvent {
  const topics = new Map<OutputType, ReturnType<PubSub['topic']>>();
  let pubsub = client;
  const configured = { ...names };
  return async (event, attributes) => {
    const name = configured[event.type];
    if (!name || !/^[a-zA-Z][a-zA-Z0-9._~+%-]{2,254}$/.test(name) || /^goog/i.test(name)) throw new Error('Output topic unavailable');
    let topic = topics.get(event.type);
    if (!topic) {
      pubsub ??= new PubSub({ projectId });
      topic = pubsub.topic(name, { batching: { maxMessages: 1 }, gaxOpts: { timeout: 5000, retry: null } });
      topics.set(event.type, topic);
    }
    return topic.publishMessage({ data: Buffer.from(JSON.stringify(event)), attributes });
  };
}
