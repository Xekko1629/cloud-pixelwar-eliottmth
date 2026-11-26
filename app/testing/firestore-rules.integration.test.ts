import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  assertFails, assertSucceeds, initializeTestEnvironment, type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { testProjectId } from './emulator-environment';

// Security Rules of the browser (ADR-0015, DRAW-03a): the file deployed by Terraform
// (infra/serverless/firestore.rules), loaded into the emulator. Read-only access to the
// deltas and to config/global; every other read and every write is refused.
//
// Never clearFirestore(): other integration files share the emulator. Every document
// written here has a unique id.

const RULES = readFileSync(new URL('../../infra/serverless/firestore.rules', import.meta.url), 'utf8');
const run = randomUUID();
const deltaId = `v1_${run}_0_0`;
const createdAt = new Date('2026-11-25T10:00:00Z');

let env: RulesTestEnvironment;

beforeAll(async () => {
  const [host, port] = process.env.FIRESTORE_EMULATOR_HOST!.split(':');
  env = await initializeTestEnvironment({
    projectId: testProjectId,
    firestore: { rules: RULES, host, port: Number(port) },
  });
  // Seed with the rules disabled, as the functions do through IAM.
  await env.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await db.doc(`deltas/${deltaId}`).set({
      encoding_version: 1, canvas_version: 1, region: `rules_${run}`, event_id: run,
      // The rules never look at the content: a placeholder stands for the encoded pixels.
      created_at: createdAt, pixels: 'encoded',
    });
    // config/global is not seeded: other files use it, and an allowed read succeeds even
    // on a missing document.
    await db.doc(`config/other_${run}`).set({ secret: true });
    for (const path of [
      `tile_colors/v1_${run}`, `tile_metadata/v1_${run}`, `users/${run}`,
      `ratelimit_overrides/${run}`, `processed_events/${run}`, `admin_events/${run}`,
    ]) {
      await db.doc(path).set({ value: 1 });
    }
  });
});

afterAll(async () => {
  await env?.cleanup();
});

// The browser never signs in (no Firebase Auth); a signed-in context must not get more.
const contexts = () => [
  ['anonymous', env.unauthenticatedContext().firestore()],
  ['signed in', env.authenticatedContext('123456789012345678').firestore()],
] as const;

describe('Firestore Security Rules of the browser', () => {
  it('allow reading a delta and querying the deltas of visible regions', async () => {
    for (const [, db] of contexts()) {
      await assertSucceeds(db.doc(`deltas/${deltaId}`).get());
      await assertSucceeds(db.collection('deltas')
        .where('canvas_version', '==', 1)
        .where('region', 'in', [`rules_${run}`, 'other'])
        .where('created_at', '>', new Date(createdAt.getTime() - 1000))
        .get());
    }
  });

  it('allow reading config/global, but no other configuration document nor a listing', async () => {
    for (const [, db] of contexts()) {
      await assertSucceeds(db.doc('config/global').get());
      await assertFails(db.doc(`config/other_${run}`).get());
      await assertFails(db.collection('config').get());
    }
  });

  it.each([
    'tile_colors/v1_', 'tile_metadata/v1_', 'users/', 'ratelimit_overrides/', 'processed_events/', 'admin_events/',
  ])('refuse reading %s', async (prefix) => {
    for (const [, db] of contexts()) {
      await assertFails(db.doc(`${prefix}${run}`).get());
      await assertFails(db.collection(prefix.split('/')[0]!).limit(1).get());
    }
  });

  it('refuse every write, including on the readable paths', async () => {
    for (const [, db] of contexts()) {
      await assertFails(db.doc(`deltas/${deltaId}`).update({ region: 'x' }));
      await assertFails(db.doc(`deltas/new_${run}`).set({ canvas_version: 1 }));
      await assertFails(db.doc(`deltas/${deltaId}`).delete());
      await assertFails(db.doc('config/global').set({ paused: true }, { merge: true }));
      await assertFails(db.doc('config/global').delete());
      await assertFails(db.doc(`users/${run}`).set({ used_pixels: 0 }));
      await assertFails(db.doc(`tile_colors/v1_${run}`).set({ colors: 'x' }));
    }
  });
});
