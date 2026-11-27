import { describe, expect, it, vi } from 'vitest';
import type { HttpFunction } from '@google-cloud/functions-framework';
import { parseDrawPush } from '../../draw-worker/src/message';
import type { Reservation } from '@pixelwar/shared/drawing';
import { createWebProxyHandler, handleWebProxy } from './index';

const ORIGIN = 'https://frontend-123456789.europe-west1.run.app';
const USER = '423456789012345678';
const NOW = Date.UTC(2026, 10, 20, 10, 0, 0, 123);
const ID = '11111111-1111-4111-8111-111111111111';
// Correlation first, then one event id per pixel.
const sequence = () => { let next = 0; return () => `${ID.slice(0, -2)}${String(next++).padStart(2, '0')}`; };
const userInfo = (claims: unknown = { sub: USER, name: 'Synthetic user' }) => Buffer.from(JSON.stringify(claims)).toString('base64url');

function request(overrides: { path?: string; method?: string; headers?: Record<string, string | undefined>; body?: unknown } = {}) {
  const headers: Record<string, string | undefined> = {
    origin: ORIGIN, 'x-apigateway-api-userinfo': userInfo(), 'content-type': 'application/json',
    ...Object.fromEntries(Object.entries(overrides.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value])),
  };
  const body = 'body' in overrides ? overrides.body : { pixels: [{ x: 12, y: -40, color: 5 }] };
  return {
    path: overrides.path ?? '/api/pixels', method: overrides.method ?? 'POST',
    get: (name: string) => headers[name.toLowerCase()],
    rawBody: Buffer.isBuffer(body) || body === undefined ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)),
  };
}
function response() {
  const res = { status: vi.fn(), json: vi.fn(), set: vi.fn(), send: vi.fn() };
  res.status.mockReturnValue(res); res.set.mockReturnValue(res);
  return res;
}
const grant = (granted: number, requested: number, reason?: Reservation['reason']) => ({
  granted, refused: requested - granted, ...(reason ? { reason } : {}), retry_after_seconds: reason === 'insufficient_quota' ? 40 : null,
  limit_per_minute: 1000, remaining_pixels: 0, reset_at: '2026-11-20T10:01:00.000Z',
});
function setup(overrides = {}) {
  const publish = vi.fn().mockResolvedValue('message-id');
  const reserve = vi.fn(async ({ pixel_count }: { pixel_count: number }) => grant(pixel_count, pixel_count));
  const log = vi.fn();
  const handler = createWebProxyHandler({ frontendOrigin: ORIGIN, publish, reserve, log, now: () => NOW, newId: sequence(), ...overrides });
  const invoke = async (req = request()) => {
    const res = response();
    await handler(req as unknown as Parameters<HttpFunction>[0], res as unknown as Parameters<HttpFunction>[1]);
    return res;
  };
  return { publish, reserve, log, invoke };
}
const headers = (res: ReturnType<typeof response>) => Object.assign({}, ...res.set.mock.calls.map(([value, extra]) =>
  typeof value === 'string' ? { [value]: extra } : value));

describe('web-proxy', () => {
  it('publishes a validated draw with the gateway identity, then answers 202', async () => {
    const { invoke, publish, log } = setup();
    const res = await invoke();
    expect(publish).toHaveBeenCalledTimes(1);
    const [event, attributes] = publish.mock.calls[0];
    const CORRELATION = `${ID.slice(0, -2)}00`; const EVENT = `${ID.slice(0, -2)}01`;
    expect(event).toEqual({
      schema_version: 1, type: 'pixel-draw', event_id: EVENT, correlation_id: CORRELATION, occurred_at: new Date(NOW).toISOString(),
      source: 'web', actor: { uid: USER, name: 'Synthetic user' }, payload: { pixels: [{ x: 12, y: -40, color: 5 }] },
    });
    expect(Object.keys(attributes).sort()).toEqual(['correlation_id', 'traceparent']);
    expect(attributes.correlation_id).toBe(CORRELATION);
    expect(attributes.traceparent).toMatch(/^00-[a-f0-9]{32}-[a-f0-9]{16}-0[01]$/);
    expect(res.status).toHaveBeenCalledWith(202);
    expect(res.json).toHaveBeenCalledWith({ correlation_id: CORRELATION, event_ids: [EVENT] });
    expect(publish.mock.invocationCallOrder[0]).toBeLessThan(res.json.mock.invocationCallOrder[0]);
    expect(headers(res)).toMatchObject({ 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': ORIGIN, Vary: 'Origin' });
    expect(JSON.stringify(log.mock.calls)).not.toContain(USER);
  });

  it('publishes one message per pixel (ADR-0014), each accepted by the real draw-worker parser', async () => {
    const { invoke, publish, log } = setup({ newId: undefined });
    const pixels = [{ x: -1e9, y: 1e9, color: 16 }, { x: 0, y: 0, color: 1 }, { x: 1, y: 0, color: 2 }];
    const res = await invoke(request({ body: { pixels } }));
    expect(publish).toHaveBeenCalledTimes(3);
    const subscription = 'projects/demo-pixelwar-test/subscriptions/draw-worker';
    const parsed = publish.mock.calls.map(([event, attributes]) => parseDrawPush({ subscription, message: {
      data: Buffer.from(JSON.stringify(event)).toString('base64'), attributes, messageId: '1',
    } }, subscription));
    expect(parsed.map((item) => item.command.pixels)).toEqual(pixels.map((pixel) => [pixel]));
    expect(new Set(parsed.map((item) => item.command.event_id)).size).toBe(3);
    expect(new Set(parsed.map((item) => item.attributes.correlation_id)).size).toBe(1);
    expect(new Set(parsed.map((item) => item.command.occurred_at)).size).toBe(1);
    expect(parsed.every((item) => item.discord === undefined)).toBe(true);
    const answer = res.json.mock.calls[0][0];
    expect(answer.event_ids).toEqual(parsed.map((item) => item.command.event_id));
    expect(answer.correlation_id).toBe(parsed[0].attributes.correlation_id);
    // One log per stroke, not per pixel.
    expect(log.mock.calls.filter(([, , fields]) => fields.event_type === 'web.proxy.published')).toHaveLength(1);
  });

  it('answers 503 when one pixel of the stroke fails, after waiting for every publication', async () => {
    const settled: string[] = [];
    const publish = vi.fn(async (event: { payload: { pixels: { x: number }[] } }) => {
      await new Promise((resolve) => setTimeout(resolve, event.payload.pixels[0].x));
      settled.push(String(event.payload.pixels[0].x));
      if (event.payload.pixels[0].x === 1) throw new Error('synthetic failure');
    });
    const { invoke } = setup({ publish });
    const res = await invoke(request({ body: { pixels: [{ x: 1, y: 0, color: 1 }, { x: 5, y: 0, color: 1 }] } }));
    expect(res.status).toHaveBeenCalledWith(503);
    expect(settled).toEqual(['1', '5']);
  });

  it('waits for the actual publication before answering', async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const { invoke } = setup({ publish: () => pending });
    const result = invoke();
    await Promise.resolve();
    finish();
    expect((await result).status).toHaveBeenCalledWith(202);
  });

  it('answers 503 without a false success when publication fails, and never logs the error', async () => {
    const { invoke, log } = setup({ publish: vi.fn().mockRejectedValue(new Error('synthetic failure with payload')) });
    const res = await invoke();
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({ error: 'publish_unavailable' });
    expect(JSON.stringify(log.mock.calls)).not.toContain('synthetic failure');
    expect(log).toHaveBeenCalledWith('ERROR', expect.any(String), { event_type: 'web.proxy.publish_failed' });
  });

  it.each([
    ['absent', undefined],
    ['malformed', 'not base64!'],
    ['incomplete', userInfo({ sub: USER })],
  ])('refuses an %s gateway identity with 401 and no publication', async (_case, value) => {
    const { invoke, publish, log } = setup();
    const res = await invoke(request({ headers: { 'X-Apigateway-Api-Userinfo': value } }));
    expect(res.status).toHaveBeenCalledWith(401);
    expect(publish).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('WARNING', expect.any(String), { event_type: 'web.proxy.refused.invalid_identity' });
  });

  it.each([
    [400, 'too_many_pixels', { pixels: Array.from({ length: 501 }, (_, x) => ({ x, y: 0, color: 1 })) }],
    [400, 'invalid_pixel', { pixels: [{ x: 1e9 + 1, y: 0, color: 1 }] }],
    [400, 'invalid_pixel', { pixels: [{ x: 0, y: 0, color: 17 }] }],
    [400, 'duplicate_pixel', { pixels: [{ x: 0, y: 0, color: 1 }, { x: 0, y: 0, color: 2 }] }],
    [400, 'invalid_json', '{'],
    [413, 'invalid_body_size', Buffer.alloc(0)],
    [413, 'invalid_body_size', Buffer.alloc(64 * 1024 + 1, 0x20)],
    [413, 'invalid_body_size', undefined],
  ])('answers %i %s without publishing', async (status, error, body) => {
    const { invoke, publish } = setup();
    const res = await invoke(request({ body }));
    expect(res.status).toHaveBeenCalledWith(status);
    expect(res.json).toHaveBeenCalledWith({ error });
    expect(publish).not.toHaveBeenCalled();
  });

  it('answers the CORS preflight of the frontend origin only', async () => {
    const { invoke, publish } = setup();
    const preflight = await invoke(request({ method: 'OPTIONS' }));
    expect(preflight.status).toHaveBeenCalledWith(204);
    expect(headers(preflight)).toMatchObject({ 'Access-Control-Allow-Origin': ORIGIN, 'Access-Control-Allow-Methods': 'POST',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type' });
    const foreign = await invoke(request({ method: 'OPTIONS', headers: { Origin: 'https://evil.example' } }));
    expect(foreign.status).toHaveBeenCalledWith(403);
    expect(headers(foreign)['Access-Control-Allow-Origin']).toBeUndefined();
    const other = await invoke(request({ headers: { Origin: 'https://evil.example' } }));
    expect(headers(other)['Access-Control-Allow-Origin']).toBeUndefined();
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('refuses other paths and methods', async () => {
    const { invoke, publish } = setup();
    expect((await invoke(request({ path: '/api/pixel' }))).status).toHaveBeenCalledWith(404);
    const get = await invoke(request({ method: 'GET' }));
    expect(get.status).toHaveBeenCalledWith(405);
    expect(get.set).toHaveBeenCalledWith('Allow', 'POST');
    expect(publish).not.toHaveBeenCalled();
  });

  it('is unavailable without its configuration', async () => {
    expect((await setup({ publish: undefined }).invoke()).status).toHaveBeenCalledWith(503);
    expect((await setup({ frontendOrigin: undefined }).invoke()).status).toHaveBeenCalledWith(503);
    const res = response();
    await handleWebProxy(request() as unknown as Parameters<HttpFunction>[0], res as unknown as Parameters<HttpFunction>[1]);
    expect(res.status).toHaveBeenCalledWith(503);
  });

  describe('quota reserved before publication (ADR-0017)', () => {
    const stroke = { pixels: [{ x: 1, y: 1, color: 1 }, { x: 2, y: 1, color: 1 }, { x: 3, y: 1, color: 1 }] };
    it('reserves once per request with the correlation id and the gateway uid', async () => {
      const { invoke, reserve } = setup();
      await invoke(request({ body: stroke }));
      expect(reserve).toHaveBeenCalledExactlyOnceWith({ reservation_id: `${ID.slice(0, -2)}00`, uid: USER, pixel_count: 3 });
    });

    it('publishes only the first granted pixels and tells the browser about the others', async () => {
      const { invoke, publish } = setup({ reserve: vi.fn().mockResolvedValue(grant(2, 3, 'insufficient_quota')) });
      const res = await invoke(request({ body: stroke }));
      expect(publish.mock.calls.map(([event]) => event.payload.pixels[0].x)).toEqual([1, 2]);
      expect(res.status).toHaveBeenCalledWith(202);
      expect(res.json).toHaveBeenCalledWith({
        correlation_id: `${ID.slice(0, -2)}00`, event_ids: [`${ID.slice(0, -2)}01`, `${ID.slice(0, -2)}02`],
        refused: { count: 1, reason: 'insufficient_quota', retry_after_seconds: 40 },
      });
    });

    it.each([['insufficient_quota', '40'], ['paused', undefined], ['drawing_disabled', undefined]] as const)(
      'answers 429 and publishes nothing when nothing is granted (%s)', async (reason, retryAfter) => {
        const { invoke, publish, log } = setup({ reserve: vi.fn().mockResolvedValue(grant(0, 3, reason)) });
        const res = await invoke(request({ body: stroke }));
        expect(publish).not.toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(429);
        expect(headers(res)['Retry-After']).toBe(retryAfter);
        expect(log.mock.calls.some(([, , fields]) => fields.event_type === `web.proxy.refused.${reason}`)).toBe(true);
      });

    it('answers 503 and publishes nothing when quota-reserver fails, without logging the error', async () => {
      const { invoke, publish, log } = setup({ reserve: vi.fn().mockRejectedValue(new Error(`secret ${USER}`)) });
      expect((await invoke(request({ body: stroke }))).status).toHaveBeenCalledWith(503);
      expect(publish).not.toHaveBeenCalled();
      expect(JSON.stringify(log.mock.calls)).not.toContain(USER);
    });

    it('is unavailable without quota-reserver', async () => {
      const { invoke, publish } = setup({ reserve: undefined });
      expect((await invoke()).status).toHaveBeenCalledWith(503);
      expect(publish).not.toHaveBeenCalled();
    });
  });
});
