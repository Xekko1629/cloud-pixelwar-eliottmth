import { randomUUID } from 'node:crypto';
import { Firestore } from '@google-cloud/firestore';
import { expect, it } from 'vitest';
import { testProjectId } from './emulator-environment';

it('reads, writes and transacts against the Firestore emulator', async () => {
  const db = new Firestore({ projectId: testProjectId });
  const reference = db.collection('test-foundation').doc(randomUUID());

  try {
    await reference.set({ count: 0 });
    await db.runTransaction(async (transaction) => {
      const document = await transaction.get(reference);
      transaction.update(reference, { count: document.get('count') + 1 });
    });
    expect((await reference.get()).get('count')).toBe(1);
  } finally {
    try {
      await reference.delete();
    } finally {
      await db.terminate();
    }
  }
});
