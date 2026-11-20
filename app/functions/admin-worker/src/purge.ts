import type { Firestore } from '@google-cloud/firestore';
import { COLLECTIONS } from '@pixelwar/shared/grid';

export interface PurgeOptions { root?: string; batchSize?: number; budgetMs?: number; now?: () => number }
export interface PurgeReport { deleted: number; complete: boolean }

/**
 * Deletes the tiles of every canvas version older than the current one (DATA-04), in
 * bounded batches. Idempotent: rerunning it only finds what is left. Deltas of old
 * versions expire through their TTL; deduplication records are kept on purpose.
 */
export async function purgeOldVersions(db: Firestore, currentVersion: number, options: PurgeOptions = {}): Promise<PurgeReport> {
  const batchSize = options.batchSize ?? 400;
  const now = options.now ?? Date.now;
  const deadline = now() + (options.budgetMs ?? 120_000);
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 500) throw new RangeError('batchSize must be between 1 and 500');
  const path = (collection: string) => options.root ? `${options.root}/${collection}` : collection;
  let deleted = 0;
  for (const collection of [COLLECTIONS.colors, COLLECTIONS.metadata]) {
    for (;;) {
      if (now() >= deadline) return { deleted, complete: false };
      // Automatic single-field index on canvas_version; only the document names are read.
      const page = await db.collection(path(collection)).where('canvas_version', '<', currentVersion)
        .select().limit(batchSize).get();
      if (page.empty) break;
      const batch = db.batch();
      for (const document of page.docs) batch.delete(document.ref);
      await batch.commit();
      deleted += page.size;
    }
  }
  return { deleted, complete: true };
}
