import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { http } from '@google-cloud/functions-framework';
import { getTestServer } from '@google-cloud/functions-framework/testing';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { commandFixture, commandPush, commandSubscription, noAdmins } from '../../../testing/command-worker-fixtures';
import { testApplication } from '../../../testing/discord-proxy-fixtures';
import { createCommandWorkerHandler } from './index';

let server: Server;
let url: string;
const publish = vi.fn().mockResolvedValue('confirmed');
const write = vi.fn();
beforeAll(async () => {
  http('command-worker-http-test', createCommandWorkerHandler({
    applicationId: testApplication, subscription: commandSubscription, permissions: noAdmins, publish, write,
  }));
  server = getTestServer('command-worker-http-test');
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});
const send = (body: unknown) => fetch(`${url}/`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(3000),
});

it('routes the actual producer payload through Functions Framework', async () => {
  const response = await send(commandPush());
  expect(response.status).toBe(204); expect(await response.text()).toBe('');
  expect(publish.mock.calls.at(-1)?.[0]).toMatchObject({ type: 'pixel-draw', source: 'discord' });
  expect(JSON.stringify(write.mock.calls)).not.toContain('synthetic-interaction-token');
});
it('returns non-2xx for publication failure so Pub/Sub can retry', async () => {
  publish.mockRejectedValueOnce(new Error('synthetic-interaction-token'));
  const response = await send(commandPush());
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain('synthetic-interaction-token');
  expect(JSON.stringify(write.mock.calls)).not.toContain('synthetic-interaction-token');
});
it('rejects invalid source messages over HTTP', async () => {
  const response = await send({ subscription: commandSubscription, message: { data: 'bad' } });
  expect(response.status).toBe(400);
});
it('publishes a refusal for unauthorized admin rather than executing it', async () => {
  const response = await send(commandPush(commandFixture('admin', { subcommand: 'clear' })));
  expect(response.status).toBe(204);
  expect(publish.mock.calls.at(-1)?.[0]).toMatchObject({ type: 'command-rejected' });
});
it('does not accept another route or an unexpected method', async () => {
  expect((await fetch(`${url}/other`, { signal: AbortSignal.timeout(3000) })).status).toBe(404);
  const response = await fetch(`${url}/`, { signal: AbortSignal.timeout(3000) });
  expect(response.status).toBe(405); expect(response.headers.get('allow')).toBe('POST');
});
