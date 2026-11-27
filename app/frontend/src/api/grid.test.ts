import { describe, expect, it, vi } from 'vitest';
import { SESSION_KEY, SessionStore } from '../auth/session';
import { TOKEN, USER, jsonResponse, memoryStorage } from '../auth/testing';
import { ApiClient } from './client';
import { fetchOverviewUrl, fetchTileMeta, fetchUserQuota, postPixels } from './grid';

function client(...answers: Response[]) {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => answers.shift() ?? jsonResponse(500, {}));
  const session = JSON.stringify({ token: TOKEN, expiresAt: Date.now() + 15 * 60_000, user: USER });
  const sessions = new SessionStore(memoryStorage({ [SESSION_KEY]: session }));
  return { fetch, api: new ApiClient({ baseUrl: 'https://gw.example.dev', sessions, fetch }) };
}

const STATE = {
  canvas_version: 3, paused: false, size: null, bounds: null, region_side: 1024,
  user: {
    limit_per_minute: 20, used_pixels: 5, remaining_pixels: 15, reset_at: '2026-11-26T10:02:00.000Z',
    last_rejection: { event_id: 'e-1', reason: 'paused', at: '2026-11-26T10:01:03.000Z' },
  },
};

describe('fetchTileMeta', () => {
  it('reads the author and date of each painted pixel', async () => {
    const { fetch, api } = client(jsonResponse(200, {
      canvas_version: 3, tx: -1, ty: 0, tile_side: 64,
      pixels: { 129: { name: 'Eliott', at: '2026-11-20T10:00:29.000Z' } },
    }));
    const meta = await fetchTileMeta(api, -1, 0);
    expect(fetch.mock.calls[0]![0]).toBe('https://gw.example.dev/api/tiles/-1/0/meta');
    expect(meta.pixels.get(129)).toEqual({ name: 'Eliott', at: new Date('2026-11-20T10:00:29.000Z') });
    expect(meta.pixels.get(0)).toBeUndefined();
  });

  it.each([
    { canvas_version: 3, tx: 5, ty: 0, pixels: {} },
    { canvas_version: 3, tx: 0, ty: 0, pixels: { 4096: { name: 'a', at: '2026-11-20T10:00:29.000Z' } } },
    { canvas_version: 3, tx: 0, ty: 0, pixels: { '01': { name: 'a', at: '2026-11-20T10:00:29.000Z' } } },
    { canvas_version: 3, tx: 0, ty: 0, pixels: { 1: { name: 'a', at: 'hier' } } },
  ])('refuses a malformed answer %#', async (body) => {
    const { api } = client(jsonResponse(200, body));
    await expect(fetchTileMeta(api, 0, 0)).rejects.toThrow('Invalid tile meta');
  });
});

describe('fetchUserQuota', () => {
  it('reads the quota and the last refusal', async () => {
    const { api } = client(jsonResponse(200, STATE));
    expect(await fetchUserQuota(api)).toEqual({
      limitPerMinute: 20, usedPixels: 5, remainingPixels: 15, resetAt: new Date('2026-11-26T10:02:00.000Z'),
      lastRejection: { eventId: 'e-1', reason: 'paused', at: new Date('2026-11-26T10:01:03.000Z') },
    });
  });

  it('accepts no refusal, and refuses a malformed quota', async () => {
    const ok = client(jsonResponse(200, { ...STATE, user: { ...STATE.user, last_rejection: null } }));
    expect((await fetchUserQuota(ok.api)).lastRejection).toBeNull();
    const bad = client(jsonResponse(200, { ...STATE, user: { ...STATE.user, remaining_pixels: -1 } }));
    await expect(fetchUserQuota(bad.api)).rejects.toThrow('Invalid state');
  });
});

describe('postPixels with a quota reserved before publication (ADR-0017)', () => {
  const pixels = [{ x: 0, y: 0, color: 1 }, { x: 1, y: 0, color: 1 }, { x: 2, y: 0, color: 1 }];
  it('reads a partial grant: the first pixels, and why the others were refused', async () => {
    const { api } = client(jsonResponse(202, { correlation_id: 'c-1', event_ids: ['e-1', 'e-2'], refused: { count: 1, reason: 'insufficient_quota', retry_after_seconds: 40 } }));
    expect(await postPixels(api, pixels)).toEqual({
      correlationId: 'c-1', eventIds: ['e-1', 'e-2'], refused: { count: 1, reason: 'insufficient_quota', retryAfterSeconds: 40 },
    });
  });
  it.each([
    { correlation_id: 'c-1', event_ids: ['e-1', 'e-2'] },
    { correlation_id: 'c-1', event_ids: ['e-1', 'e-2', 'e-3'], refused: { count: 0, reason: 'x', retry_after_seconds: null } },
    { correlation_id: 'c-1', event_ids: ['e-1'], refused: { count: 1, reason: 'insufficient_quota', retry_after_seconds: null } },
    { correlation_id: 'c-1', event_ids: ['e-1', 'e-2'], refused: { count: 1, reason: 2, retry_after_seconds: null } },
    { correlation_id: 'c-1', event_ids: [], refused: { count: 3, reason: 'paused', retry_after_seconds: null } },
  ])('refuses an answer that does not add up: %j', async (body) => {
    const { api } = client(jsonResponse(202, body));
    await expect(postPixels(api, pixels)).rejects.toThrow('Invalid draw answer');
  });
  it('surfaces a 429 as an ApiError with the reason', async () => {
    const { api } = client(jsonResponse(429, { error: 'insufficient_quota', retry_after_seconds: 40 }));
    await expect(postPixels(api, pixels)).rejects.toMatchObject({ status: 429, code: 'insufficient_quota' });
  });
});

describe('postPixels', () => {
  it('posts the pixels with the session and returns the event ids', async () => {
    const { fetch, api } = client(jsonResponse(202, { correlation_id: 'c-1', event_ids: ['e-1'] }));
    expect(await postPixels(api, [{ x: -3, y: 4, color: 5 }])).toEqual({ correlationId: 'c-1', eventIds: ['e-1'] });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('https://gw.example.dev/api/pixels');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual({ pixels: [{ x: -3, y: 4, color: 5 }] });
  });

  it('checks the request before sending it, and the answer after', async () => {
    const { fetch, api } = client(jsonResponse(202, { correlation_id: 'c-1', event_ids: [] }));
    await expect(postPixels(api, [])).rejects.toThrow(RangeError);
    await expect(postPixels(api, [{ x: 0, y: 0, color: 17 }])).rejects.toThrow(RangeError);
    expect(fetch).not.toHaveBeenCalled();
    await expect(postPixels(api, [{ x: 0, y: 0, color: 1 }])).rejects.toThrow('Invalid draw');
  });

  it('passes the refusal code of the gateway', async () => {
    const { api } = client(jsonResponse(503, { error: 'publish_unavailable' }));
    await expect(postPixels(api, [{ x: 0, y: 0, color: 1 }])).rejects.toMatchObject({ status: 503, code: 'publish_unavailable' });
  });
});

describe('fetchOverviewUrl', () => {
  const answer = { canvas_version: 3, level: 2, cx: -1, cy: 0, url: 'https://storage.googleapis.com/b/v3/2/-1_0.png?X-Goog-Signature=s', expires_at: '2026-11-26T12:15:00.000Z' };

  it('reads the signed URL of a far-view image', async () => {
    const { api, fetch } = client(jsonResponse(200, answer));
    expect(await fetchOverviewUrl(api, 2, -1, 0)).toEqual({
      canvasVersion: 3, url: answer.url, expiresAt: new Date('2026-11-26T12:15:00.000Z'),
    });
    expect(String(fetch.mock.calls[0]![0])).toBe('https://gw.example.dev/api/overview/2/-1/0');
  });

  it.each([
    { ...answer, cx: 5 },
    { ...answer, url: 'http://storage.googleapis.com/x.png' },
    { ...answer, expires_at: 'soon' },
  ])('refuses an answer that does not match: %o', async (body) => {
    const { api } = client(jsonResponse(200, body));
    await expect(fetchOverviewUrl(api, 2, -1, 0)).rejects.toThrow('Invalid overview answer');
  });
});
