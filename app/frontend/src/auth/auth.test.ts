import { describe, expect, it, vi } from 'vitest';
import { ApiClient } from '../api/client';
import { Auth, STATE_KEY } from './auth';
import { SessionStore } from './session';
import { jsonResponse, memoryStorage, sessionBody, TOKEN, USER } from './testing';

const NOW = Date.parse('2026-11-25T10:00:00Z');
const MINUTE = 60_000;
const AUTHORIZE = 'https://discord.com/oauth2/authorize?client_id=1&state=s';
const STATE = 'eyJhbGciOiJSUzI1NiJ9.c3RhdGU.c2ln';
const CODE = 'AbCdEf0123456789';
const NEW_TOKEN = 'test-header.renewed-payload.test-signature';

function setup(options: { responses?: Array<Response | Error>; session?: number; gateway?: boolean } = {}) {
  const responses = options.responses ?? [];
  const storage = memoryStorage();
  const sessions = new SessionStore(storage, () => NOW);
  if (options.session !== undefined) sessions.set({ token: TOKEN, expiresAt: NOW + options.session, user: USER });
  const fetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => {
    const next = responses.shift();
    if (!next) throw new Error('unexpected request');
    if (next instanceof Error) throw next;
    return next;
  });
  const api = options.gateway === false
    ? null
    : new ApiClient({ baseUrl: 'https://gw.example.dev', sessions, fetch, now: () => NOW });
  const timers: Array<{ callback: () => void; ms: number; cleared: boolean }> = [];
  const auth = new Auth({
    api, sessions, storage, now: () => NOW,
    setTimer: (callback, ms) => {
      // A timer that fired is no longer active, like a real one.
      const timer = { callback: () => { timer.cleared = true; callback(); }, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => { (timer as { cleared: boolean }).cleared = true; },
  });
  const active = () => timers.filter((timer) => !timer.cleared);
  return { auth, sessions, storage, fetch, active };
}

function pendingState(state = STATE, expiresAt = NOW + 10 * MINUTE): string {
  return JSON.stringify({ state, expiresAt });
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const LOGIN_EXPIRY = new Date(NOW + 10 * MINUTE).toISOString();

describe('Auth.startLogin', () => {
  it('keeps the state in the tab and returns the Discord URL', async () => {
    const { auth, storage, fetch } = setup({
      responses: [jsonResponse(200, { authorize_url: AUTHORIZE, state: STATE, expires_at: LOGIN_EXPIRY })],
    });
    const url = auth.startLogin();
    expect(auth.getState()).toEqual({ status: 'pending' });
    await expect(url).resolves.toBe(AUTHORIZE);
    expect(fetch.mock.calls[0]![0]).toBe('https://gw.example.dev/auth/login');
    expect(JSON.parse(storage.entries.get(STATE_KEY)!)).toEqual({ state: STATE, expiresAt: NOW + 10 * MINUTE });
  });

  it.each([
    ['a gateway error', () => jsonResponse(503, { error: 'unavailable' })],
    ['a URL outside Discord', () => jsonResponse(200, { authorize_url: 'https://evil.example/discord.com', state: STATE, expires_at: LOGIN_EXPIRY })],
    ['an http URL', () => jsonResponse(200, { authorize_url: 'http://discord.com/oauth2/authorize', state: STATE, expires_at: LOGIN_EXPIRY })],
    ['no state', () => jsonResponse(200, { authorize_url: AUTHORIZE, expires_at: LOGIN_EXPIRY })],
  ])('reports the login as unavailable on %s', async (_label, response) => {
    const { auth, storage } = setup({ responses: [response()] });
    await expect(auth.startLogin()).resolves.toBeNull();
    expect(auth.getState()).toEqual({ status: 'signed-out', error: 'unavailable' });
    expect(storage.entries.has(STATE_KEY)).toBe(false);
  });

  it('reports the login as unavailable without a gateway', async () => {
    const { auth } = setup({ gateway: false });
    await expect(auth.startLogin()).resolves.toBeNull();
    expect(auth.getState()).toEqual({ status: 'signed-out', error: 'unavailable' });
  });
});

describe('Auth.completeLogin', () => {
  it('exchanges the code once and signs in', async () => {
    const { auth, storage, fetch, sessions } = setup({ responses: [jsonResponse(200, sessionBody(NOW + 60 * MINUTE))] });
    storage.setItem(STATE_KEY, pendingState());
    const listener = vi.fn();
    auth.subscribe(listener);
    const search = `?code=${CODE}&state=${STATE}`;
    // React StrictMode runs the effect twice: a Discord code can only be used once.
    await Promise.all([auth.completeLogin(search), auth.completeLogin(search)]);
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('https://gw.example.dev/auth/exchange');
    expect(JSON.parse(init!.body as string)).toEqual({ code: CODE, state: STATE });
    expect(auth.getState()).toEqual({ status: 'signed-in', user: USER });
    expect(sessions.get()?.token).toBe(TOKEN);
    expect(storage.entries.has(STATE_KEY)).toBe(false);
    expect(listener).toHaveBeenCalled();
  });

  it.each([
    ['a state from another login', `?code=${CODE}&state=other`, pendingState()],
    ['no stored state', `?code=${CODE}&state=${STATE}`, null],
    ['an expired state', `?code=${CODE}&state=${STATE}`, pendingState(STATE, NOW)],
    ['a corrupted stored state', `?code=${CODE}&state=${STATE}`, '{'],
    ['no code', `?state=${STATE}`, pendingState()],
  ])('refuses %s without calling the gateway', async (_label, search, stored) => {
    const { auth, storage, fetch } = setup();
    if (stored !== null) storage.setItem(STATE_KEY, stored);
    await auth.completeLogin(search);
    expect(fetch).not.toHaveBeenCalled();
    expect(auth.getState()).toEqual({ status: 'signed-out', error: 'invalid_state' });
    expect(storage.entries.has(STATE_KEY)).toBe(false);
  });

  it('reports a login cancelled on Discord', async () => {
    const { auth, storage } = setup();
    storage.setItem(STATE_KEY, pendingState());
    await auth.completeLogin(`?error=access_denied&state=${STATE}`);
    expect(auth.getState()).toEqual({ status: 'signed-out', error: 'denied' });
  });

  it.each([
    ['code_refused', () => jsonResponse(401, { error: 'code_refused' }), 'code_refused'],
    ['invalid_state', () => jsonResponse(401, { error: 'invalid_state' }), 'invalid_state'],
    ['upstream_unavailable', () => jsonResponse(502, { error: 'upstream_unavailable' }), 'unavailable'],
    ['an invalid session', () => jsonResponse(200, { token: 'not-a-jwt' }), 'unavailable'],
  ])('reports a refused exchange: %s', async (_label, response, error) => {
    const { auth, storage, sessions } = setup({ responses: [response()] });
    storage.setItem(STATE_KEY, pendingState());
    await auth.completeLogin(`?code=${CODE}&state=${STATE}`);
    expect(auth.getState()).toEqual({ status: 'signed-out', error });
    expect(sessions.get()).toBeNull();
  });

  it('reports the login as unavailable without a gateway', async () => {
    const { auth, storage } = setup({ gateway: false });
    storage.setItem(STATE_KEY, pendingState());
    await auth.completeLogin(`?code=${CODE}&state=${STATE}`);
    expect(auth.getState()).toEqual({ status: 'signed-out', error: 'unavailable' });
  });
});

describe('Auth session lifecycle', () => {
  it('starts signed in with a stored session and schedules its renewal', () => {
    const { auth, active } = setup({ session: 60 * MINUTE });
    expect(auth.getState()).toEqual({ status: 'signed-in', user: USER });
    expect(active()).toHaveLength(1);
    expect(active()[0]!.ms).toBe(55 * MINUTE);
  });

  it('renews the session when the timer fires, then schedules the next renewal', async () => {
    const { auth, active, fetch } = setup({
      session: 60 * MINUTE,
      responses: [jsonResponse(200, sessionBody(NOW + 120 * MINUTE, NEW_TOKEN))],
    });
    active()[0]!.callback();
    await flush();
    expect(fetch.mock.calls[0]![0]).toBe('https://gw.example.dev/api/session/refresh');
    expect(auth.getState()).toEqual({ status: 'signed-in', user: USER });
    expect(active()).toHaveLength(1);
    expect(active()[0]!.ms).toBe(115 * MINUTE);
  });

  it('retries a minute later when the gateway is unreachable', async () => {
    const { active, fetch } = setup({ session: 60 * MINUTE, responses: [new TypeError('network')] });
    active()[0]!.callback();
    await flush();
    expect(active()).toHaveLength(1);
    expect(active()[0]!.ms).toBe(MINUTE);
    active()[0]!.callback();
    expect(active()).toHaveLength(1);
    expect(active()[0]!.ms).toBe(55 * MINUTE);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('signs out with a message when the gateway refuses the renewal', async () => {
    const { auth, active } = setup({ session: 60 * MINUTE, responses: [jsonResponse(401, { error: 'session_expired' })] });
    active()[0]!.callback();
    await flush();
    expect(auth.getState()).toEqual({ status: 'signed-out', error: 'session_expired' });
    expect(active()).toHaveLength(0);
  });

  it('signs out on request, without an error message, and stops the timer', () => {
    const { auth, sessions, storage, active } = setup({ session: 60 * MINUTE });
    auth.signOut();
    expect(auth.getState()).toEqual({ status: 'signed-out', error: null });
    expect(sessions.get()).toBeNull();
    expect([...storage.entries.keys()]).toEqual([]);
    expect(active()).toHaveLength(0);
  });

  it('schedules nothing without a gateway', () => {
    const { active } = setup({ session: 60 * MINUTE, gateway: false });
    expect(active()).toHaveLength(0);
  });
});
