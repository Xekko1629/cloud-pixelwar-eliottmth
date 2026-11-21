import { gunzipSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import type { HttpFunction } from '@google-cloud/functions-framework';
import { TILE_PIXELS, decodeRegionTiles } from '@pixelwar/shared/grid';
import { createTileReaderHandler, handleTileReader } from './index';
import type { TileStore } from './store';

const ORIGIN = 'https://frontend-123456789.europe-west1.run.app';
const USER = '423456789012345678';
const NOW = Date.parse('2026-11-20T10:01:05.000Z');
const userInfo = Buffer.from(JSON.stringify({ sub: USER, name: 'Synthetic user' })).toString('base64url');
const config = { paused: false, canvas_version: 4, size: null, bounds: null, default_limit_per_minute: 20 };

function store(overrides: Partial<TileStore> = {}): TileStore & Record<string, ReturnType<typeof vi.fn>> {
  const colors = new Uint8Array(TILE_PIXELS); colors[1] = 6;
  return {
    config: vi.fn().mockResolvedValue(config),
    regionTiles: vi.fn().mockResolvedValue([{ tx: 0, ty: 0, colors }]),
    tileAuthors: vi.fn().mockResolvedValue({ 1: { name: 'Eliott', at: { seconds: 1_763_632_800, nanoseconds: 0 } } }),
    user: vi.fn().mockResolvedValue({ usage: null, override: null }),
    ...overrides,
  } as TileStore & Record<string, ReturnType<typeof vi.fn>>;
}
function request(path: string, overrides: { method?: string; headers?: Record<string, string | undefined> } = {}) {
  const headers: Record<string, string | undefined> = {
    origin: ORIGIN, 'x-apigateway-api-userinfo': userInfo,
    ...Object.fromEntries(Object.entries(overrides.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value])),
  };
  return { path, method: overrides.method ?? 'GET', get: (name: string) => headers[name.toLowerCase()] };
}
function response() {
  const res = { status: vi.fn(), json: vi.fn(), set: vi.fn(), send: vi.fn() };
  res.status.mockReturnValue(res); res.set.mockReturnValue(res);
  return res;
}
const headers = (res: ReturnType<typeof response>) => Object.assign({}, ...res.set.mock.calls.map(([value, extra]) =>
  typeof value === 'string' ? { [value]: extra } : value));
function setup(overrides: Record<string, unknown> = {}) {
  const reads = store();
  const log = vi.fn();
  const handler = createTileReaderHandler({ frontendOrigin: ORIGIN, store: reads, log, now: () => NOW, ...overrides });
  const invoke = async (req: ReturnType<typeof request>) => {
    const res = response();
    await handler(req as unknown as Parameters<HttpFunction>[0], res as unknown as Parameters<HttpFunction>[1]);
    return res;
  };
  return { reads, log, invoke };
}

describe('tile-reader', () => {
  it('serves the binary tiles of a region for the current canvas version', async () => {
    const { invoke, reads } = setup();
    const res = await invoke(request('/api/regions/0/0/tiles'));
    expect(reads.regionTiles).toHaveBeenCalledWith(4, '0_0');
    expect(res.status).toHaveBeenCalledWith(200);
    const decoded = decodeRegionTiles(res.send.mock.calls[0][0], 0, 0);
    expect(decoded.canvas_version).toBe(4);
    expect(decoded.tiles[0].colors[1]).toBe(6);
    expect(headers(res)).toMatchObject({ 'Content-Type': 'application/octet-stream', 'Cache-Control': 'private, no-cache',
      'Access-Control-Allow-Origin': ORIGIN, 'Access-Control-Expose-Headers': 'ETag', Vary: 'Origin, Accept-Encoding' });
    expect(headers(res).ETag).toMatch(/^W\/"/);
  });

  it('compresses the region tiles when the browser accepts gzip', async () => {
    const { invoke } = setup();
    const plain = await invoke(request('/api/regions/0/0/tiles'));
    const gzip = await invoke(request('/api/regions/0/0/tiles', { headers: { 'Accept-Encoding': 'gzip, deflate, br' } }));
    expect(headers(gzip)['Content-Encoding']).toBe('gzip');
    const compressed: Buffer = gzip.send.mock.calls[0][0];
    expect(compressed.byteLength).toBeLessThan(plain.send.mock.calls[0][0].byteLength / 10);
    expect(gunzipSync(compressed)).toEqual(plain.send.mock.calls[0][0]);
    expect(headers(gzip).ETag).toBe(headers(plain).ETag);
  });

  it('answers 304 without a body when the browser already has the same content', async () => {
    const { invoke } = setup();
    const first = await invoke(request('/api/regions/0/0/tiles'));
    const again = await invoke(request('/api/regions/0/0/tiles', { headers: { 'If-None-Match': headers(first).ETag } }));
    expect(again.status).toHaveBeenCalledWith(304);
    expect(again.send).toHaveBeenCalledWith();
    expect(headers(again)).toMatchObject({ ETag: headers(first).ETag, 'Cache-Control': 'private, no-cache' });
  });

  it('serves the author names and dates of a tile', async () => {
    const { invoke, reads } = setup();
    const res = await invoke(request('/api/tiles/0/-1/meta'));
    expect(reads.tileAuthors).toHaveBeenCalledWith(4, 0, -1);
    expect(JSON.parse(res.send.mock.calls[0][0].toString())).toMatchObject({
      canvas_version: 4, tx: 0, ty: -1, pixels: { 1: { name: 'Eliott', at: '2025-11-20T10:00:00.000Z' } },
    });
    expect(headers(res)['Content-Type']).toBe('application/json; charset=utf-8');
    expect(headers(res)['Content-Encoding']).toBeUndefined();
  });

  it('serves the configuration and the quota of the caller only', async () => {
    const { invoke, reads } = setup();
    const res = await invoke(request('/api/state'));
    expect(reads.user).toHaveBeenCalledWith(USER);
    expect(JSON.parse(res.send.mock.calls[0][0].toString())).toMatchObject({
      canvas_version: 4, paused: false, user: { limit_per_minute: 20, remaining_pixels: 20, reset_at: '2026-11-20T10:02:00.000Z' },
    });
  });

  it('answers 503 without logging stored data when a read fails', async () => {
    const { invoke, log } = setup({ store: store({ config: vi.fn().mockRejectedValue(new Error('secret stored detail')) }) });
    const res = await invoke(request('/api/state'));
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({ error: 'read_unavailable' });
    expect(headers(res)['Cache-Control']).toBe('no-store');
    expect(JSON.stringify(log.mock.calls)).not.toContain('secret stored detail');
    expect(log).toHaveBeenCalledWith('ERROR', expect.any(String), { event_type: 'tile_reader.read_failed' });
  });

  it.each([
    ['absent', undefined],
    ['malformed', 'not base64!'],
  ])('refuses an %s gateway identity with 401 before any read', async (_case, value) => {
    const { invoke, reads } = setup();
    const res = await invoke(request('/api/state', { headers: { 'X-Apigateway-Api-Userinfo': value } }));
    expect(res.status).toHaveBeenCalledWith(401);
    expect(reads.config).not.toHaveBeenCalled();
  });

  it('answers 400 for coordinates outside the grid and 404 for unknown paths', async () => {
    const { invoke, reads, log } = setup();
    const outside = await invoke(request('/api/regions/976563/0/tiles'));
    expect(outside.status).toHaveBeenCalledWith(400);
    expect(outside.json).toHaveBeenCalledWith({ error: 'invalid_coordinates' });
    expect(log).toHaveBeenCalledWith('WARNING', expect.any(String), { event_type: 'tile_reader.refused.invalid_coordinates' });
    expect((await invoke(request('/api/regions/01/0/tiles'))).status).toHaveBeenCalledWith(404);
    expect(reads.config).not.toHaveBeenCalled();
  });

  it('answers the CORS preflight of the frontend origin only, and GET only', async () => {
    const { invoke, reads } = setup();
    const preflight = await invoke(request('/api/state', { method: 'OPTIONS' }));
    expect(preflight.status).toHaveBeenCalledWith(204);
    expect(headers(preflight)).toMatchObject({ 'Access-Control-Allow-Methods': 'GET', 'Access-Control-Allow-Headers': 'Authorization' });
    const foreign = await invoke(request('/api/state', { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } }));
    expect(foreign.status).toHaveBeenCalledWith(403);
    expect(headers(foreign)['Access-Control-Allow-Origin']).toBeUndefined();
    const post = await invoke(request('/api/state', { method: 'POST' }));
    expect(post.status).toHaveBeenCalledWith(405);
    expect(post.set).toHaveBeenCalledWith('Allow', 'GET');
    expect(reads.config).not.toHaveBeenCalled();
  });

  it('is unavailable without its configuration', async () => {
    expect((await setup({ store: undefined }).invoke(request('/api/state'))).status).toHaveBeenCalledWith(503);
    expect((await setup({ frontendOrigin: undefined }).invoke(request('/api/state'))).status).toHaveBeenCalledWith(503);
    const res = response();
    await handleTileReader(request('/api/state') as unknown as Parameters<HttpFunction>[0], res as unknown as Parameters<HttpFunction>[1]);
    expect(res.status).toHaveBeenCalledWith(503);
  });
});
