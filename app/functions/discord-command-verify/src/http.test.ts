import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { http } from '@google-cloud/functions-framework';
import { getTestServer } from '@google-cloud/functions-framework/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { commandEvent } from '../../discord-proxy/src/event';
import { drawInteraction, testApplication } from '../../../testing/discord-proxy-fixtures';
import { createDiscordCommandVerifyHandler } from './index';

describe('verification worker through the real Functions Framework', () => {
  let server: Server;
  let url: string;
  const write = vi.fn();
  const subscription = 'projects/pixelwar-test/subscriptions/discord-command-verify';
  beforeAll(async () => {
    http('discord-command-verify-http-test', createDiscordCommandVerifyHandler({
      environment: 'dev', applicationId: testApplication, subscription, write,
    }));
    server = getTestServer('discord-command-verify-http-test');
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  });
  afterAll(async () => {
    if (server) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  function send(body: unknown) {
    return fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(3000),
    });
  }
  it('decodes the producer contract over HTTP and returns an empty acknowledgement', async () => {
    const event = commandEvent(drawInteraction(), testApplication);
    const result = await send({ subscription, message: {
      messageId: '123', data: Buffer.from(JSON.stringify(event)).toString('base64'),
      attributes: { correlation_id: event.event_id, traceparent: `00-${'1'.repeat(32)}-${'2'.repeat(16)}-00` },
    } });
    expect(result.status).toBe(204); expect(await result.text()).toBe('');
    expect(JSON.parse(write.mock.calls.at(-1)![0])).toMatchObject({ event_id: event.event_id, message_id: '123' });
    expect(JSON.stringify(write.mock.calls)).not.toContain(event.payload.interaction_token);
  });
  it('does not acknowledge an invalid message over HTTP', async () => {
    const result = await send({ subscription, message: { data: 'synthetic-interaction-token' } });
    expect(result.status).toBe(400);
    expect(JSON.stringify(write.mock.calls)).not.toContain('synthetic-interaction-token');
  });
});
