import type { PubSub } from '@google-cloud/pubsub';
import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ publishMessage: vi.fn(), topic: vi.fn(), construct: vi.fn() }));
vi.mock('@google-cloud/pubsub', () => ({ PubSub: class {
  constructor(options: unknown) { mocks.construct(options); }
  topic(...args: unknown[]) { mocks.topic(...args); return { publishMessage: mocks.publishMessage }; }
} }));
import { commandPush, commandSubscription, noAdmins } from '../../../testing/command-worker-fixtures';
import { testApplication } from '../../../testing/discord-proxy-fixtures';
import { parsePush } from './message';
import { routeCommand } from './route';
import { createEventPublisher } from './publisher';

beforeEach(() => { vi.clearAllMocks(); mocks.publishMessage.mockResolvedValue('confirmed'); });
const parsed = () => parsePush(commandPush(), commandSubscription, testApplication);
const event = () => routeCommand(parsed().command, noAdmins);

it('lazily initializes and caches bounded SDK publishers', async () => {
  const names = { 'pixel-draw': 'pixel-draw' };
  const publish = createEventPublisher('demo-pixelwar-test', names);
  names['pixel-draw'] = 'changed';
  expect(mocks.construct).not.toHaveBeenCalled();
  expect(await publish(event(), parsed().attributes)).toBe('confirmed');
  await publish(event(), parsed().attributes);
  expect(mocks.construct).toHaveBeenCalledTimes(1);
  expect(mocks.topic).toHaveBeenCalledTimes(1);
  expect(mocks.topic).toHaveBeenCalledWith('pixel-draw', { batching: { maxMessages: 1 }, gaxOpts: { timeout: 5000, retry: null } });
  expect(mocks.publishMessage.mock.calls[0][0]).toEqual({ data: Buffer.from(JSON.stringify(event())), attributes: parsed().attributes });
});
it('supports an injected emulator client and separate route caches', async () => {
  const client = { topic: vi.fn(() => ({ publishMessage: mocks.publishMessage })) };
  const publish = createEventPublisher('demo-pixelwar-test', { 'pixel-draw': 'pixel-draw', 'render-requested': 'render-requested' }, client as unknown as PubSub);
  await publish(event(), parsed().attributes);
  await publish({ ...event(), type: 'render-requested', payload: { discord: parsed().command.discord } }, parsed().attributes);
  expect(client.topic).toHaveBeenCalledTimes(2);
  expect(mocks.construct).not.toHaveBeenCalled();
});
it.each([undefined, '', 'x', 'goog-reserved', 'with/slash'])('fails without SDK calls on unavailable topic %s', async (name) => {
  const publish = createEventPublisher('demo-pixelwar-test', { 'pixel-draw': name });
  await expect(publish(event(), parsed().attributes)).rejects.toThrow('Output topic unavailable');
  expect(mocks.construct).not.toHaveBeenCalled();
});
it('preserves SDK failures for the handler retry decision', async () => {
  mocks.publishMessage.mockRejectedValue(new Error('temporary outage'));
  const publish = createEventPublisher('demo-pixelwar-test', { 'pixel-draw': 'pixel-draw' });
  await expect(publish(event(), parsed().attributes)).rejects.toThrow('temporary outage');
});
