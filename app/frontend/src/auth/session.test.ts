import { describe, expect, it, vi } from 'vitest';
import { parseSessionResponse, safeStorage, SESSION_KEY, SessionStore } from './session';
import { memoryStorage, sessionBody, TOKEN, USER } from './testing';

const NOW = Date.parse('2026-11-25T10:00:00Z');
const HOUR = 3_600_000;

describe('parseSessionResponse', () => {
  it('reads the answer of /auth/exchange', () => {
    expect(parseSessionResponse(sessionBody(NOW + HOUR))).toEqual({ token: TOKEN, expiresAt: NOW + HOUR, user: USER });
  });

  it.each([
    ['no body', null],
    ['an array', []],
    ['no user', { token: TOKEN, expires_at: '2026-11-25T11:00:00Z' }],
    ['a token that is not a JWT', { ...sessionBody(NOW), token: 'opaque' }],
    ['a bad date', { ...sessionBody(NOW), expires_at: 'tomorrow' }],
    ['a numeric date', { ...sessionBody(NOW), expires_at: NOW }],
    ['a bad user id', { ...sessionBody(NOW), user: { id: '01', name: 'a' } }],
    ['an empty name', { ...sessionBody(NOW), user: { id: USER.id, name: '' } }],
    ['a name too long', { ...sessionBody(NOW), user: { id: USER.id, name: 'x'.repeat(81) } }],
  ])('refuses %s', (_label, body) => {
    expect(parseSessionResponse(body)).toBeNull();
  });
});

describe('SessionStore', () => {
  const session = { token: TOKEN, expiresAt: NOW + HOUR, user: USER };

  it('keeps the session in memory and in storage, without anything from Discord', () => {
    const storage = memoryStorage();
    const store = new SessionStore(storage, () => NOW);
    store.set(session);
    expect(store.get()).toEqual(session);
    expect(JSON.parse(storage.entries.get(SESSION_KEY)!)).toEqual(session);
  });

  it('restores a stored session after a reload', () => {
    const storage = memoryStorage({ [SESSION_KEY]: JSON.stringify(session) });
    expect(new SessionStore(storage, () => NOW).get()).toEqual(session);
  });

  it.each([
    ['expired', JSON.stringify({ ...session, expiresAt: NOW })],
    ['corrupted', '{not json'],
    ['tampered', JSON.stringify({ ...session, token: 'x' })],
  ])('drops a %s stored session', (_label, raw) => {
    const storage = memoryStorage({ [SESSION_KEY]: raw });
    expect(new SessionStore(storage, () => NOW).get()).toBeNull();
    expect(storage.entries.has(SESSION_KEY)).toBe(false);
  });

  it('forgets the session once it expires, and tells the listeners', () => {
    let now = NOW;
    const store = new SessionStore(memoryStorage(), () => now);
    store.set(session);
    const listener = vi.fn();
    store.subscribe(listener);
    now = NOW + HOUR;
    expect(store.get()).toBeNull();
    expect(listener).toHaveBeenCalledOnce();
  });

  it('works in memory when the storage throws', () => {
    const broken = {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); },
      removeItem: () => { throw new Error('blocked'); },
    };
    const store = new SessionStore(broken, () => NOW);
    store.set(session);
    expect(store.get()).toEqual(session);
    store.clear();
    expect(store.get()).toBeNull();
  });

  it('notifies clear only when there was a session', () => {
    const store = new SessionStore(undefined, () => NOW);
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    store.clear();
    expect(listener).not.toHaveBeenCalled();
    store.set(session);
    unsubscribe();
    store.clear();
    expect(listener).toHaveBeenCalledOnce();
  });
});

describe('safeStorage', () => {
  it('returns undefined when the browser refuses access', () => {
    expect(safeStorage(() => { throw new Error('SecurityError'); })).toBeUndefined();
    const storage = memoryStorage();
    expect(safeStorage(() => storage)).toBe(storage);
  });
});
