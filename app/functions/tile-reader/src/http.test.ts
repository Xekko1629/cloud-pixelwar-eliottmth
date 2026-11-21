import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { http } from '@google-cloud/functions-framework';
import { getTestServer } from '@google-cloud/functions-framework/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { TILE_PIXELS, decodeRegionTiles } from '@pixelwar/shared/grid';
import { createTileReaderHandler } from './index';

const ORIGIN = 'https://frontend-123456789.europe-west1.run.app';
const userInfo = Buffer.from(JSON.stringify({ sub: '423456789012345678', name: 'Synthetic user' })).toString('base64url');

describe('tile-reader through the real Functions Framework', () => {
  let server: Server;
  let base: string;
  beforeAll(async () => {
    const colors = new Uint8Array(TILE_PIXELS); colors[0] = 3;
    http('tile-reader-http-test', createTileReaderHandler({ frontendOrigin: ORIGIN, log: vi.fn(), store: {
      config: async () => ({ paused: false, canvas_version: 2, size: null, bounds: null, default_limit_per_minute: 20 }),
      regionTiles: async () => [{ tx: -1, ty: -1, colors }],
      tileAuthors: async () => ({}),
      user: async () => ({ usage: null, override: null }),
    } }));
    server = getTestServer('tile-reader-http-test');
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    if (server) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  const get = (path: string, headers: Record<string, string> = {}) => fetch(`${base}${path}`, {
    signal: AbortSignal.timeout(3000), headers: { Origin: ORIGIN, 'X-Apigateway-Api-Userinfo': userInfo, ...headers },
  });

  it('serves gzip region tiles that a browser fetch decodes transparently', async () => {
    const result = await get('/api/regions/-1/-1/tiles', { 'Accept-Encoding': 'gzip' });
    expect(result.status).toBe(200);
    expect(result.headers.get('content-encoding')).toBe('gzip');
    const decoded = decodeRegionTiles(new Uint8Array(await result.arrayBuffer()), -1, -1);
    expect(decoded.tiles).toHaveLength(1);
    expect(decoded.tiles[0]).toMatchObject({ tx: -1, ty: -1 });
    expect(decoded.tiles[0].colors[0]).toBe(3);
  });

  it('revalidates with the ETag over HTTP', async () => {
    const first = await get('/api/state');
    const etag = first.headers.get('etag')!;
    expect(first.status).toBe(200);
    const again = await get('/api/state', { 'If-None-Match': etag });
    expect(again.status).toBe(304);
    expect(await again.text()).toBe('');
  });

  it('refuses a request without the gateway identity', async () => {
    expect((await get('/api/state', { 'X-Apigateway-Api-Userinfo': '' })).status).toBe(401);
  });
});
