import { initializeApp } from 'firebase/app';
import {
  Timestamp, collection, doc, getFirestore, onSnapshot, query, where, type QueryConstraint,
} from 'firebase/firestore';
import type { FirestoreConfig } from '../config';
import type { FirestoreBackend } from './feed';

// The only file that imports the Firebase SDK, and only firebase/app and firebase/firestore
// (ADR-0015): no Auth, Analytics nor Hosting. It is loaded on demand (import()), so the
// page renders before the SDK is downloaded.

/** Opens the read-only listeners allowed by the Security Rules. */
export function createFirestoreBackend(config: FirestoreConfig): FirestoreBackend {
  // A named app: the default one is left free, nothing else in the page uses Firebase.
  const app = initializeApp({ projectId: config.projectId, apiKey: config.apiKey }, 'pixelwar-realtime');
  const db = getFirestore(app);

  return {
    watchConfig(next, error) {
      // Metadata changes too: a snapshot "from cache" means the connection is lost, and the
      // next one from the server means it is back (DRAW-03b). The SDK never raises an error
      // for a network cut, it keeps the listener and resyncs on its own.
      return onSnapshot(
        doc(db, 'config', 'global'),
        { includeMetadataChanges: true },
        (snapshot) => next(snapshot.data() ?? null, snapshot.metadata.fromCache),
        error,
      );
    },

    watchDeltas(request, added, error) {
      // Same fields and order as the composite indexes deltas_by_region and deltas_global.
      const filters: QueryConstraint[] = [where('canvas_version', '==', request.canvasVersion)];
      if (request.regions !== null) filters.push(where('region', 'in', request.regions));
      filters.push(where('created_at', '>', Timestamp.fromMillis(request.since)));
      return onSnapshot(query(collection(db, 'deltas'), ...filters), (snapshot) => {
        // Only new documents: a delta is never modified, and its TTL removal changes nothing.
        const documents = snapshot.docChanges()
          .filter((change) => change.type === 'added')
          .map((change) => change.doc.data());
        added(documents, snapshot.metadata.fromCache);
      }, error);
    },
  };
}
