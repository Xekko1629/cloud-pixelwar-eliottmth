import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { http } from '@google-cloud/functions-framework';
import { getTestServer } from '@google-cloud/functions-framework/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createWebProxyHandler } from './index';

const ORIGIN = 'https://frontend-123456789.europe-west1.run.app';
const userInfo = Buffer.from(JSON.stringify({ sub: '423456789012345678', name: 'Synthetic user' })).toString('base64url');

describe('web-proxy through the real Functions Framework', () => {
  let server: Server;
  let url: string;
  const publish = vi.fn().mockResolvedValue('confirmed');
  beforeAll(async () => {
    http('web-proxy-http-test', createWebProxyHandler({ frontendOrigin: ORIGIN, publish, log: vi.fn(),
      reserve: async ({ pixel_count }) => ({ granted: pixel_count, refused: 0, retry_after_seconds: null, limit_per_minute: 1000, remaining_pixels: 0, reset_at: '2026-11-20T10:01:00.000Z' }) }));
    server = getTestServer('web-proxy-http-test');
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/pixels`;
  });
  afterAll(async () => {
    if (server) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  const send = (body: string, method = 'POST', headers: Record<string, string> = {}) => fetch(url, {
    method, signal: AbortSignal.timeout(3000), ...(method === 'POST' ? { body } : {}),
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN, 'X-Apigateway-Api-Userinfo': userInfo, ...headers },
  });

  it('publishes a draw sent as a gateway would forward it', async () => {
    const result = await send(' { "pixels" : [ { "x" : 1, "y" : -2, "color" : 3 } ] } ');
    expect(result.status).toBe(202);
    const answer = await result.json();
    expect(answer.event_ids).toHaveLength(1);
    expect(answer.event_ids[0]).not.toBe(answer.correlation_id);
    expect(result.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0][0].payload).toEqual({ pixels: [{ x: 1, y: -2, color: 3 }] });
  });

  it('answers the browser preflight', async () => {
    const result = await send('', 'OPTIONS', { 'Access-Control-Request-Method': 'POST' });
    expect(result.status).toBe(204);
    expect(result.headers.get('access-control-allow-methods')).toBe('POST');
  });

  it('refuses a request without the gateway identity', async () => {
    publish.mockClear();
    const result = await send('{"pixels":[{"x":1,"y":2,"color":3}]}', 'POST', { 'X-Apigateway-Api-Userinfo': '' });
    expect(result.status).toBe(401);
    expect(publish).not.toHaveBeenCalled();
  });
});
