import { randomUUID } from 'node:crypto';
import { Firestore } from '@google-cloud/firestore';
import { afterAll, beforeEach, expect, it } from 'vitest';
import { testProjectId } from '../../../testing/emulator-environment';
import { createQuotaReservation } from './reservation';

const now = Date.parse('2026-11-27T15:30:20.000Z');
const uid = '123456789012345678';
const db = new Firestore({ projectId: testProjectId });
const roots: string[] = [];
let root: string;

beforeEach(async () => {
  root = `reservation_tests/${randomUUID()}`;
  roots.push(root);
  await db.doc(`${root}/config/global`).set({ paused: false, canvas_version: 1, size: null, bounds: null, default_limit_per_minute: 1000 });
});
afterAll(async () => {
  try { for (const path of roots) await db.recursiveDelete(db.doc(path)); }
  finally { await db.terminate(); }
});

it('never grants more than the limit to concurrent requests of one user (ADR-0017)', async () => {
  const reserve = createQuotaReservation(db, { root, now: () => now });
  const answers = await Promise.all(Array.from({ length: 6 }, () => reserve({ reservation_id: randomUUID(), uid, pixel_count: 300 })));
  expect(answers.reduce((sum, answer) => sum + answer.granted, 0)).toBe(1000);
  expect((await db.doc(`${root}/users/${uid}`).get()).data()).toMatchObject({ used_pixels: 1000 });
});

it('does not count a retried reservation twice', async () => {
  const reserve = createQuotaReservation(db, { root, now: () => now });
  const id = randomUUID();
  const [first, second] = await Promise.all([reserve({ reservation_id: id, uid, pixel_count: 200 }), reserve({ reservation_id: id, uid, pixel_count: 200 })]);
  expect(second).toEqual(first);
  expect((await db.doc(`${root}/users/${uid}`).get()).data()).toMatchObject({ used_pixels: 200 });
});
