import { generateKeyPairSync, sign } from 'node:crypto';
import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { http } from '@google-cloud/functions-framework';
import { getTestServer } from '@google-cloud/functions-framework/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDiscordHelloHandler } from './index';

describe('Discord callback through the real Functions Framework', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const hex = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
  let server: Server;
  let url: string;

  beforeAll(async () => {
    http('discord-hello-http-test', createDiscordHelloHandler({ environment: 'dev', publicKey: hex, log: vi.fn() }));
    server = getTestServer('discord-hello-http-test');
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/discord/interactions`;
  });

  afterAll(async () => {
    if (!server) return;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });

  function send(body: string, valid = true) {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = sign(null, Buffer.from(timestamp + body), privateKey).toString('hex');
    return fetch(url, {
      method: 'POST', body,
      headers: {
        'Content-Type': 'application/json', 'X-Signature-Timestamp': timestamp,
        'X-Signature-Ed25519': valid ? signature : '00'.repeat(64),
      },
      signal: AbortSignal.timeout(3_000),
    });
  }

  it('receives raw bytes including whitespace and returns PONG', async () => {
    const result = await send(' { "type" : 1 } ');
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ type: 1 });
  });

  it('reads the string parameter and returns the immediate interaction response', async () => {
    const result = await send(JSON.stringify({ type: 2, data: {
      type: 1, name: 'hello', options: [{ type: 3, name: 'nom', value: 'Élodie' }],
    } }));
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ type: 4, data: {
      content: 'Hello Élodie !', flags: 0, allowed_mentions: { parse: [] },
    } });
  });

  it('rejects invalid signatures with 401', async () => {
    const result = await send('{"type":1}', false);
    expect(result.status).toBe(401);
    expect(await result.json()).toEqual({ error: 'Invalid request signature.' });
  });
});
