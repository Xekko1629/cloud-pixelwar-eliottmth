import type { PubSub } from '@google-cloud/pubsub';
import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ publishMessage: vi.fn(), topic: vi.fn(), construct: vi.fn() }));
vi.mock('@google-cloud/pubsub', () => ({ PubSub: class {
  constructor(options: unknown) { mocks.construct(options); }
  topic(...args: unknown[]) { mocks.topic(...args); return { publishMessage: mocks.publishMessage }; }
} }));
import { drawPush, drawSubscription, processedResult } from '../../../testing/draw-worker-fixtures';
import { parseDrawPush } from './message';
import { resultEvent } from './result';
import { createResultPublisher } from './publisher';

beforeEach(() => { vi.clearAllMocks(); mocks.publishMessage.mockResolvedValue('confirmed'); });
const parsed = () => parseDrawPush(drawPush(), drawSubscription);
const event = () => resultEvent(processedResult(parsed().command), parsed().command, parsed().attributes.correlation_id);
it('lazily caches publishers and bounds the RPC', async () => {
  const names = { 'pixel-processed': 'pixel-processed' };
  const publish = createResultPublisher('demo-pixelwar-test', names); names['pixel-processed'] = 'changed';
  expect(mocks.construct).not.toHaveBeenCalled();
  expect(await publish(event(), parsed().attributes)).toBe('confirmed'); await publish(event(), parsed().attributes);
  expect(mocks.construct).toHaveBeenCalledTimes(1); expect(mocks.topic).toHaveBeenCalledTimes(1);
  expect(mocks.topic).toHaveBeenCalledWith('pixel-processed', { batching: { maxMessages: 1 }, gaxOpts: { timeout: 5000, retry: null } });
  expect(mocks.publishMessage.mock.calls[0][0]).toEqual({ data: Buffer.from(JSON.stringify(event())), attributes: parsed().attributes });
});
it('supports a local emulator client and a rejection topic', async () => {
  const client = { topic: vi.fn(() => ({ publishMessage: mocks.publishMessage })) };
  const publish = createResultPublisher('demo-pixelwar-test', { 'pixel-rejected': 'pixel-rejected' }, client as unknown as PubSub);
  await publish({ ...event(), type: 'pixel-rejected' }, parsed().attributes);
  expect(client.topic).toHaveBeenCalledWith('pixel-rejected', expect.any(Object)); expect(mocks.construct).not.toHaveBeenCalled();
});
it.each([undefined, '', 'x', 'goog-reserved', 'with/slash'])('fails without acknowledging a missing/invalid topic %s', async (name) => {
  await expect(createResultPublisher('demo-pixelwar-test', { 'pixel-processed': name })(event(), parsed().attributes)).rejects.toThrow('Result topic unavailable');
  expect(mocks.construct).not.toHaveBeenCalled();
});
it('propagates publication failure to the HTTP retry boundary', async () => {
  mocks.publishMessage.mockRejectedValueOnce(new Error('temporary outage'));
  await expect(createResultPublisher('demo-pixelwar-test', { 'pixel-processed': 'pixel-processed' })(event(), parsed().attributes)).rejects.toThrow('temporary outage');
});
