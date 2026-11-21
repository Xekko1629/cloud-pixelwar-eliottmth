import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { http } from '@google-cloud/functions-framework';
import { getTestServer } from '@google-cloud/functions-framework/testing';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { notificationEvent, notifierNow, notifierPush, notifierSubscriptions } from '../../../testing/discord-notifier-fixtures';
import { testApplication, testNow } from '../../../testing/discord-proxy-fixtures';
import { startFakeDiscord } from '../../../testing/fake-discord';
import { createOriginalResponseUpdater } from './discord';
import { createDiscordNotifierHandler } from './index';
import { parseNoticePush, TOKEN_LIFETIME_MS, type DiscordNotice } from './message';

let api: Awaited<ReturnType<typeof startFakeDiscord>>;
let server: Server;
let url: string;
let now = notifierNow;
const write = vi.fn();
beforeAll(async () => {
  api = await startFakeDiscord();
  http('discord-notifier-http-test', createDiscordNotifierHandler({ applicationId: testApplication, subscriptions: notifierSubscriptions,
    update: createOriginalResponseUpdater({ fetch: api.fetch, now: () => now }), write }));
  server = getTestServer('discord-notifier-http-test');
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
beforeEach(() => { now = notifierNow; api.requests.length = 0; api.messages.clear(); api.responses.length = 0; write.mockClear(); });
afterAll(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  if (api) await api.close();
});
const send = (body: unknown = notifierPush()) => fetch(`${url}/`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body), signal: AbortSignal.timeout(3000) });

it('updates the original response through real HTTP on both sides', async () => {
  const response = await send(); expect(response.status).toBe(204); expect(await response.text()).toBe('');
  expect(api.requests).toHaveLength(1); expect(api.requests[0].method).toBe('PATCH');
  expect(api.requests[0].path.endsWith('/messages/@original')).toBe(true);
  expect(api.requests[0].body).toMatchObject({ content: expect.stringContaining('Pixels appliqués : 1'), allowed_mentions: { parse: [] } });
  expect(JSON.stringify(write.mock.calls)).not.toMatch(/synthetic-interaction-token|webhooks/);
});
it('makes duplicates overwrite the same single message', async () => {
  const responses = await Promise.all([send(), send()]);
  for (const response of responses) expect(response.status).toBe(204);
  expect(api.requests).toHaveLength(2); expect(api.messages.size).toBe(1);
  expect(api.requests[0]).toEqual(api.requests[1]);
});
it('renders a business refusal rather than a success', async () => {
  expect((await send(notifierPush(notificationEvent('pixel-rejected', 'discord', 'rate_limit')))).status).toBe(204);
  expect(api.requests[0].body).toMatchObject({ content: expect.stringContaining('Quota dépassé') });
});
it('does not call Discord for expired notifications', async () => {
  now = testNow + TOKEN_LIFETIME_MS;
  expect((await send()).status).toBe(204); expect(api.requests).toHaveLength(0);
  expect(JSON.parse(write.mock.calls[0][0])).toMatchObject({ severity: 'WARNING', event_type: 'discord.notification.expired' });
});
it('ignores web results without an external request', async () => {
  expect((await send(notifierPush(notificationEvent('pixel-processed', 'web')))).status).toBe(204);
  expect(api.requests).toHaveLength(0);
});
it('retries after an HTTP outage without exposing response content', async () => {
  api.responses.push({ status: 503 });
  const failed = await send(); expect(failed.status).toBe(503); expect(await failed.text()).not.toContain('synthetic-interaction-token');
  expect((await send()).status).toBe(204); expect(api.messages.size).toBe(1);
  expect(JSON.stringify(write.mock.calls)).not.toMatch(/synthetic-interaction-token|webhooks/);
});
it('returns a safe rate-limit response', async () => {
  api.responses.push({ status: 429, headers: { 'Retry-After': '2.5' } });
  const response = await send(); expect(response.status).toBe(503); expect(response.headers.get('retry-after')).toBe('3');
});
it('does not follow a redirect carrying the token', async () => {
  api.responses.push({ status: 302, headers: { Location: 'http://127.0.0.1:1/forbidden-redirect' } });
  expect((await send()).status).toBe(503); expect(api.requests).toHaveLength(1);
});
it('aborts a slow HTTP request instead of waiting indefinitely', async () => {
  api.responses.push({ status: 200, delayMs: 100 });
  const notice = parseNoticePush(notifierPush(), notifierSubscriptions, testApplication) as DiscordNotice;
  const update = createOriginalResponseUpdater({ fetch: api.fetch, now: () => notifierNow, timeoutMs: 20 });
  await expect(update(notice)).rejects.toMatchObject({ reason: 'network' });
  // Let the local server finish its simulated delayed operation before the next test.
  await new Promise<void>((resolve) => setTimeout(resolve, 120));
});
it('rejects malformed messages before any outbound request', async () => {
  expect((await send({ subscription: 'bad' })).status).toBe(400); expect(api.requests).toHaveLength(0);
});
it('restricts the route and method', async () => {
  expect((await fetch(`${url}/other`, { signal: AbortSignal.timeout(3000) })).status).toBe(404);
  const response = await fetch(`${url}/`, { signal: AbortSignal.timeout(3000) });
  expect(response.status).toBe(405); expect(response.headers.get('allow')).toBe('POST');
});
