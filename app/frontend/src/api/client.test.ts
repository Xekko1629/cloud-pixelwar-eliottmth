import { describe, expect, it, vi } from 'vitest';
import { SessionStore } from '../auth/session';
import { jsonResponse, sessionBody, TOKEN, USER } from '../auth/testing';
import { ApiClient, ApiError, REFRESH_PATH } from './client';

const NOW = Date.parse('2026-11-25T10:00:00Z');
const MINUTE = 60_000;
const BASE = 'https://gw.example.dev';
const NEW_TOKEN = 'test-header.renewed-payload.test-signature';

function setup(expiresIn: number | null, responses: Array<Response | Error>) {
  const sessions = new SessionStore(undefined, () => NOW);
  if (expiresIn !== null) sessions.set({ token: TOKEN, expiresAt: NOW + expiresIn, user: USER });
  const fetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => {
    const next = responses.shift();
    if (!next) throw new Error('unexpected request');
    if (next instanceof Error) throw next;
    return next;
  });
  const onSignedOut = vi.fn();
  const api = new ApiClient({ baseUrl: BASE, sessions, fetch, now: () => NOW, onSignedOut });
  return { api, sessions, fetch, onSignedOut };
}

function headers(init: RequestInit | undefined): Record<string, string> {
  return init?.headers as Record<string, string>;
}

describe('ApiClient.request', () => {
  it('sends the session JWT as a Bearer token', async () => {
    const { api, fetch } = setup(30 * MINUTE, [jsonResponse(200, { ok: true })]);
    await expect(api.json('/api/state')).resolves.toEqual({ ok: true });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(`${BASE}/api/state`);
    expect(init?.method).toBe('GET');
    expect(headers(init).Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('sends no token to a public route, and a JSON body when given one', async () => {
    const { api, fetch } = setup(30 * MINUTE, [jsonResponse(200, {})]);
    await api.json('/auth/exchange', { code: 'c', state: 's' }, { auth: false });
    const init = fetch.mock.calls[0]![1];
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe('{"code":"c","state":"s"}');
    expect(headers(init)['Content-Type']).toBe('application/json');
    expect(headers(init).Authorization).toBeUndefined();
  });

  it('refuses an authenticated call without a session, without a request', async () => {
    const { api, fetch, onSignedOut } = setup(null, []);
    await expect(api.request('/api/state')).rejects.toEqual(new ApiError(401, 'no_session'));
    expect(fetch).not.toHaveBeenCalled();
    expect(onSignedOut).toHaveBeenCalledWith('no_session');
  });

  it('ends the session on a 401 of the gateway', async () => {
    const { api, sessions, onSignedOut } = setup(30 * MINUTE, [new Response('{"code":401,"message":"Jwt is expired"}', { status: 401 })]);
    await expect(api.request('/api/state')).rejects.toMatchObject({ status: 401, code: 'http_401' });
    expect(sessions.get()).toBeNull();
    expect(onSignedOut).toHaveBeenCalledWith('http_401');
  });

  it('keeps the session on other errors and reports their code', async () => {
    const { api, sessions } = setup(30 * MINUTE, [jsonResponse(400, { error: 'duplicate_pixel' }), new Response('oops', { status: 502 })]);
    await expect(api.request('/api/pixels', { method: 'POST' })).rejects.toEqual(new ApiError(400, 'duplicate_pixel'));
    await expect(api.request('/api/pixels', { method: 'POST' })).rejects.toEqual(new ApiError(502, 'http_502'));
    expect(sessions.get()).not.toBeNull();
  });

  it('does not sign out on a 401 of a public route', async () => {
    const { api, sessions, onSignedOut } = setup(30 * MINUTE, [jsonResponse(401, { error: 'invalid_state' })]);
    await expect(api.request('/auth/exchange', { auth: false })).rejects.toEqual(new ApiError(401, 'invalid_state'));
    expect(sessions.get()).not.toBeNull();
    expect(onSignedOut).not.toHaveBeenCalled();
  });

  it('returns a 304 to the caller (ETag of the tiles)', async () => {
    const { api } = setup(30 * MINUTE, [new Response(null, { status: 304 })]);
    await expect(api.request('/api/regions/0/0/tiles')).resolves.toMatchObject({ status: 304 });
  });

  it('renews a session about to expire before the call', async () => {
    const { api, fetch, sessions } = setup(2 * MINUTE, [
      jsonResponse(200, sessionBody(NOW + 60 * MINUTE, NEW_TOKEN)),
      jsonResponse(200, {}),
    ]);
    await api.json('/api/state');
    expect(fetch.mock.calls[0]![0]).toBe(`${BASE}${REFRESH_PATH}`);
    expect(headers(fetch.mock.calls[0]![1]).Authorization).toBe(`Bearer ${TOKEN}`);
    expect(headers(fetch.mock.calls[1]![1]).Authorization).toBe(`Bearer ${NEW_TOKEN}`);
    expect(sessions.get()?.token).toBe(NEW_TOKEN);
  });

  it('uses the current token when the renewal cannot reach the gateway', async () => {
    const { api, fetch } = setup(2 * MINUTE, [new TypeError('network'), jsonResponse(200, {})]);
    await api.json('/api/state');
    expect(headers(fetch.mock.calls[1]![1]).Authorization).toBe(`Bearer ${TOKEN}`);
  });
});

describe('ApiClient.refresh', () => {
  it('shares one request between concurrent callers', async () => {
    const { api, fetch } = setup(30 * MINUTE, [jsonResponse(200, sessionBody(NOW + 60 * MINUTE, NEW_TOKEN))]);
    const [a, b] = await Promise.all([api.refresh(), api.refresh()]);
    expect(a).toBe(b);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('signs out when the gateway refuses the renewal (login older than 12 h)', async () => {
    const { api, sessions, onSignedOut } = setup(30 * MINUTE, [jsonResponse(401, { error: 'session_expired' })]);
    await expect(api.refresh()).resolves.toBeNull();
    expect(sessions.get()).toBeNull();
    expect(onSignedOut).toHaveBeenCalledWith('session_expired');
  });

  it('throws on an unavailable gateway or an invalid answer, keeping the session', async () => {
    const { api, sessions } = setup(30 * MINUTE, [jsonResponse(503, { error: 'unavailable' }), jsonResponse(200, { token: 'x' })]);
    await expect(api.refresh()).rejects.toEqual(new ApiError(503, 'unavailable'));
    await expect(api.refresh()).rejects.toEqual(new ApiError(200, 'invalid_response'));
    expect(sessions.get()?.token).toBe(TOKEN);
  });

  it('does nothing without a session', async () => {
    const { api, fetch } = setup(null, []);
    await expect(api.refresh()).resolves.toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not bring back a session closed during the renewal', async () => {
    const { sessions } = setup(30 * MINUTE, []);
    let answer!: (response: Response) => void;
    const slow = new ApiClient({
      baseUrl: BASE, sessions, now: () => NOW,
      fetch: () => new Promise<Response>((resolve) => { answer = resolve; }),
    });
    const pending = slow.refresh();
    sessions.clear();
    answer(jsonResponse(200, sessionBody(NOW + 60 * MINUTE, NEW_TOKEN)));
    await expect(pending).resolves.toBeNull();
    expect(sessions.get()).toBeNull();
  });
});
