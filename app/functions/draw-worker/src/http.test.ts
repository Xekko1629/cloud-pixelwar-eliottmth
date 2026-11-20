import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { http } from '@google-cloud/functions-framework';
import { getTestServer } from '@google-cloud/functions-framework/testing';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { DrawProcessingError } from '@pixelwar/shared/drawing';
import { drawPush, drawSubscription, processedResult } from '../../../testing/draw-worker-fixtures';
import { createDrawWorkerHandler } from './index';

let server: Server;
let url: string;
const process = vi.fn(async (command) => processedResult(command));
const publish = vi.fn().mockResolvedValue('confirmed');
beforeAll(async () => {
  http('draw-worker-http-test', createDrawWorkerHandler({ subscription: drawSubscription, process, publish, write: vi.fn() }));
  server = getTestServer('draw-worker-http-test');
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});
const send = (body: unknown) => fetch(`${url}/`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body), signal: AbortSignal.timeout(3000) });

it('accepts a real JSON push through Functions Framework', async () => {
  const response = await send(drawPush());
  expect(response.status).toBe(204); expect(await response.text()).toBe('');
  expect(publish.mock.calls.at(-1)?.[0]).toMatchObject({ type: 'pixel-processed' });
});
it('does not acknowledge a publication outage after processing', async () => {
  publish.mockRejectedValueOnce(new Error('synthetic-secret'));
  const response = await send(drawPush());
  expect(response.status).toBe(503); expect(await response.text()).not.toContain('synthetic-secret');
});
it('quarantines invalid business input instead of pretending the lot was drawn', async () => {
  process.mockRejectedValueOnce(new DrawProcessingError('invalid_command', 'synthetic-secret'));
  const response = await send(drawPush());
  expect(response.status).toBe(400); expect(await response.text()).not.toContain('synthetic-secret');
});
it('retries technical Firestore errors', async () => {
  process.mockRejectedValueOnce(new Error('synthetic-secret'));
  expect((await send(drawPush())).status).toBe(503);
});
it('restricts the path and method', async () => {
  expect((await fetch(`${url}/other`, { signal: AbortSignal.timeout(3000) })).status).toBe(404);
  const response = await fetch(`${url}/`, { signal: AbortSignal.timeout(3000) });
  expect(response.status).toBe(405); expect(response.headers.get('allow')).toBe('POST');
});
