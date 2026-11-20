import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { http } from '@google-cloud/functions-framework';
import { getTestServer } from '@google-cloud/functions-framework/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDiscordProxyHandler } from './index';
import { drawInteraction, signedRequest, testApplication, testNow, testPublicKey } from '../../../testing/discord-proxy-fixtures';

describe('Discord proxy through the real Functions Framework', () => {
  let server: Server;
  let url: string;
  const publish = vi.fn().mockResolvedValue('confirmed');
  beforeAll(async () => {
    http('discord-proxy-http-test', createDiscordProxyHandler({
      publicKey: testPublicKey, applicationId: testApplication, now: () => testNow, publish, log: vi.fn(),
    }));
    server = getTestServer('discord-proxy-http-test');
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/discord/interactions`;
  });
  afterAll(async () => {
    if (server) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  function send(body: unknown, valid = true) {
    const request = signedRequest(body);
    return fetch(url, {
      method: 'POST', body: request.rawBody!.toString('utf8'), signal: AbortSignal.timeout(3000),
      headers: {
        'Content-Type': 'application/json',
        'X-Signature-Timestamp': request.get('X-Signature-Timestamp')!,
        'X-Signature-Ed25519': valid ? request.get('X-Signature-Ed25519')! : '00'.repeat(64),
      },
    });
  }
  it('preserves whitespace in the raw signed body for PING', async () => {
    const result = await send(` { "type" : 1, "application_id" : "${testApplication}" } `);
    expect(result.status).toBe(200); expect(await result.json()).toEqual({ type: 1 });
    expect(publish).not.toHaveBeenCalled();
  });
  it('publishes a command and returns the deferred response over HTTP', async () => {
    const result = await send(drawInteraction());
    expect(result.status).toBe(200); expect(await result.json()).toEqual({ type: 5 });
    expect(publish).toHaveBeenCalledTimes(1);
  });
  it('rejects an invalid signature over HTTP without publication', async () => {
    publish.mockClear();
    const result = await send(drawInteraction(), false);
    expect(result.status).toBe(401); expect(publish).not.toHaveBeenCalled();
  });
});
