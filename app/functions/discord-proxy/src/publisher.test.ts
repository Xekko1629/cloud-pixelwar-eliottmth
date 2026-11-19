import { expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ publishMessage: vi.fn(), topic: vi.fn(), construct: vi.fn() }));
vi.mock('@google-cloud/pubsub', () => ({ PubSub: class {
  constructor(options: unknown) { mocks.construct(options); }
  topic(...args: unknown[]) { mocks.topic(...args); return { publishMessage: mocks.publishMessage }; }
} }));
import { createCommandPublisher } from './publisher';
import { commandEvent } from './event';
import { drawInteraction, testApplication } from '../../../testing/discord-proxy-fixtures';

it('creates the client lazily, reuses it and bounds RPC retries without dropping the promise', async () => {
  const publish = createCommandPublisher('demo-pixelwar-test', 'discord-command');
  expect(mocks.construct).not.toHaveBeenCalled();
  mocks.publishMessage.mockResolvedValue('confirmed');
  const event = commandEvent(drawInteraction(), testApplication);
  expect(await publish(event, { correlation_id: event.event_id })).toBe('confirmed');
  await publish(event, {});
  expect(mocks.construct).toHaveBeenCalledTimes(1);
  expect(mocks.topic).toHaveBeenCalledWith('discord-command', {
    batching: { maxMessages: 1 }, gaxOpts: { timeout: 1000, retry: null },
  });
  expect(mocks.publishMessage.mock.calls[0][0]).toEqual({
    data: Buffer.from(JSON.stringify(event)), attributes: { correlation_id: event.event_id },
  });
  mocks.publishMessage.mockRejectedValue(new Error('unavailable'));
  await expect(publish(event, {})).rejects.toThrow('unavailable');
});
