import { describe, expect, it, vi } from 'vitest';
import type { PubSub } from '@google-cloud/pubsub';
const mocks = vi.hoisted(() => ({ publishMessage: vi.fn(), topic: vi.fn(), construct: vi.fn() }));
vi.mock('@google-cloud/pubsub', () => ({ PubSub: class {
  constructor(options: unknown) { mocks.construct(options); }
  topic(...args: unknown[]) { mocks.topic(...args); return { publishMessage: mocks.publishMessage }; }
} }));
import { createDrawPublisher } from './publisher';
import { webDrawEvent } from './request';

const event = webDrawEvent([{ x: 1, y: 2, color: 3 }], { uid: '423456789012345678', name: 'Synthetic user' }, 0);
const attributes = { correlation_id: event.correlation_id, traceparent: `00-${'1'.repeat(32)}-${'2'.repeat(16)}-01` };

describe('pixel-draw publisher', () => {
  it('creates the client lazily once and bounds RPC retries without dropping the promise', async () => {
    const publish = createDrawPublisher('demo-pixelwar-test', 'pixel-draw');
    expect(mocks.construct).not.toHaveBeenCalled();
    mocks.publishMessage.mockResolvedValue('confirmed');
    expect(await publish(event, attributes)).toBe('confirmed');
    await publish(event, attributes);
    expect(mocks.construct).toHaveBeenCalledTimes(1);
    expect(mocks.construct).toHaveBeenCalledWith({ projectId: 'demo-pixelwar-test' });
    expect(mocks.topic).toHaveBeenCalledWith('pixel-draw', { batching: { maxMessages: 1 }, gaxOpts: { timeout: 5000, retry: null } });
    mocks.publishMessage.mockRejectedValue(new Error('unavailable'));
    await expect(publish(event, attributes)).rejects.toThrow('unavailable');
  });

  it('publishes the event as JSON with the propagation attributes only, on an injected client', async () => {
    const publishMessage = vi.fn().mockResolvedValue('1');
    const topic = vi.fn().mockReturnValue({ publishMessage });
    await createDrawPublisher('demo-pixelwar-test', 'pixel-draw', { topic } as unknown as PubSub)(event, attributes);
    const [message] = publishMessage.mock.calls[0];
    expect(JSON.parse(message.data.toString('utf8'))).toEqual(event);
    expect(message.attributes).toEqual(attributes);
  });
});
