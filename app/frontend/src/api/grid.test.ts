import { describe, expect, it, vi } from 'vitest';
import { SESSION_KEY, SessionStore } from '../auth/session';
import { TOKEN, USER, jsonResponse, memoryStorage } from '../auth/testing';
import { ApiClient } from './client';
import { fetchTileMeta, fetchUserQuota, postPixels } from './grid';

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
