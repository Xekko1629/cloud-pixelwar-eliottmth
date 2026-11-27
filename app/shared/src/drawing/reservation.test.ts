import { Timestamp, type Firestore } from '@google-cloud/firestore';
import { describe, expect, it, vi } from 'vitest';
import { createQuotaReservation, parseReservationRequest } from './reservation';

const now = Date.parse('2026-11-27T15:30:20.000Z');
const window = Date.parse('2026-11-27T15:30:00.000Z');
const uid = '123456789012345678';
const request = (changes: Record<string, unknown> = {}) => ({ reservation_id: 'a813cf97-0000-4000-8000-000000000001', uid, pixel_count: 500, ...changes });

function fakeStore(config: Record<string, unknown> = {}) {
  const store = new Map<string, Record<string, unknown>>();
  store.set('config/global', { paused: false, canvas_version: 1, size: null, bounds: null, default_limit_per_minute: 1000, ...config });
  const snapshot = (ref: { path: string }) => ({ exists: store.has(ref.path), data: () => store.get(ref.path) });
  const writes: (() => void)[] = [];
  const tx = {
    getAll: vi.fn(async (...refs) => refs.map(snapshot)),
    set: vi.fn((ref, data, settings) => { writes.push(() => { store.set(ref.path, settings?.merge ? { ...store.get(ref.path), ...data } : data); }); }),
    update: vi.fn((ref, data) => { writes.push(() => { store.set(ref.path, { ...store.get(ref.path), ...data }); }); }),
  };
  const db = {
    doc: (path: string) => ({ path }),
    runTransaction: async (work: (transaction: typeof tx) => Promise<unknown>) => {
      writes.length = 0;
      const result = await work(tx);
      for (const write of writes) write();
      return result;
    },
  } as unknown as Firestore;
  return { db, store, tx };
}
const usage = (used: number) => ({
  window_start: Timestamp.fromMillis(window), used_pixels: used, limit_per_minute: 1000,
  updated_at: Timestamp.fromMillis(now - 1000), last_rejection: null,
});

describe('parseReservationRequest', () => {
  it('keeps a valid request', () => { expect(parseReservationRequest(request())).toEqual(request()); });
  it.each([
    null, [], {}, request({ extra: 1 }), request({ reservation_id: '' }), request({ reservation_id: 'a b' }),
    request({ uid: '12' }), request({ uid: 12 }), request({ pixel_count: 0 }), request({ pixel_count: 501 }), request({ pixel_count: 1.5 }),
  ])('refuses %j', (value) => { expect(() => parseReservationRequest(value)).toThrow('Invalid reservation request'); });
});

describe('createQuotaReservation (ADR-0017)', () => {
  const reserve = (db: Firestore) => createQuotaReservation(db, { now: () => now });

  it('grants the whole request and counts it once in users/{uid}', async () => {
    const { db, store } = fakeStore();
    store.set(`users/${uid}`, usage(100));
    expect(await reserve(db)(request())).toEqual({
      granted: 500, refused: 0, retry_after_seconds: null, limit_per_minute: 1000, remaining_pixels: 400, reset_at: '2026-11-27T15:31:00.000Z',
    });
    expect(store.get(`users/${uid}`)).toMatchObject({ used_pixels: 600, last_rejection: null, last_reservation: { id: request().reservation_id } });
  });

  it('grants the first pixels that fit and refuses the rest, with the wait', async () => {
    const { db, store } = fakeStore();
    store.set(`users/${uid}`, usage(700));
    expect(await reserve(db)(request())).toMatchObject({
      granted: 300, refused: 200, reason: 'insufficient_quota', retry_after_seconds: 40, remaining_pixels: 0,
    });
    expect(store.get(`users/${uid}`)).toMatchObject({ used_pixels: 1000, last_rejection: { reason: 'rate_limit' } });
  });

  it('grants up to the limit when one request is larger than the whole limit', async () => {
    const { db } = fakeStore({ default_limit_per_minute: 20 });
    expect(await reserve(db)(request())).toMatchObject({ granted: 20, refused: 480, reason: 'insufficient_quota' });
  });

  it('refuses everything when nothing is left, without consuming', async () => {
    const { db, store } = fakeStore();
    store.set(`users/${uid}`, usage(1000));
    expect(await reserve(db)(request())).toMatchObject({ granted: 0, refused: 500, reason: 'insufficient_quota', retry_after_seconds: 40 });
    expect(store.get(`users/${uid}`)).toMatchObject({ used_pixels: 1000, last_rejection: { reason: 'rate_limit' } });
  });

  it.each([
    [{ paused: true }, 'paused'], [{ default_limit_per_minute: 0 }, 'drawing_disabled'],
  ])('refuses %j with %s and creates a first user with nothing consumed', async (config, reason) => {
    const { db, store } = fakeStore(config);
    expect(await reserve(db)(request())).toMatchObject({ granted: 0, reason, retry_after_seconds: null });
    expect(store.get(`users/${uid}`)).toMatchObject({ used_pixels: 0, window_start: Timestamp.fromMillis(window) });
  });

  it('applies the admin override of this user', async () => {
    const { db, store } = fakeStore({ default_limit_per_minute: 20 });
    store.set(`ratelimit_overrides/${uid}`, { limit_per_minute: 5000, updated_at: Timestamp.fromMillis(now - 60_000) });
    expect(await reserve(db)(request())).toMatchObject({ granted: 500, limit_per_minute: 5000 });
  });

  it('returns the same answer for a retried reservation_id, without counting twice', async () => {
    const { db, store } = fakeStore();
    const first = await reserve(db)(request());
    const again = await reserve(db)(request());
    expect(again).toEqual(first);
    expect(store.get(`users/${uid}`)).toMatchObject({ used_pixels: 500 });
    await reserve(db)(request({ reservation_id: 'second-request' }));
    expect(store.get(`users/${uid}`)).toMatchObject({ used_pixels: 1000 });
  });

  it('refuses an invalid request before any read, and a broken config', async () => {
    const { db, tx } = fakeStore();
    await expect(reserve(db)(request({ pixel_count: 0 }))).rejects.toThrow('Invalid reservation request');
    expect(tx.getAll).not.toHaveBeenCalled();
    await expect(reserve(fakeStore({ canvas_version: 'x' }).db)(request())).rejects.toThrow();
  });

  it('supports an isolated document root', async () => {
    const { db, store } = fakeStore();
    store.set('tests/unit/config/global', store.get('config/global')!);
    await createQuotaReservation(db, { now: () => now, root: 'tests/unit' })(request());
    expect(store.has(`tests/unit/users/${uid}`)).toBe(true);
  });
});
