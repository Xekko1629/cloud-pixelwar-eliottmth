import type { Firestore } from '@google-cloud/firestore';
import {
  COLLECTIONS, assertCanvasVersion, tileId, tileRegionId, validateTileColors, validateTimestamp,
  type GlobalConfigDocument, type RateLimitOverrideDocument, type TimestampValue, type UserStateDocument,
} from '@pixelwar/shared/grid';

export interface StoredTile { tx: number; ty: number; colors: Uint8Array }
export interface PixelAuthor { name: string; at: TimestampValue }
export interface UserReadState { usage: UserStateDocument | null; override: RateLimitOverrideDocument | null }

/** Read-only port: the runtime identity only has roles/datastore.viewer (SRV-11). */
export interface TileStore {
  config(): Promise<GlobalConfigDocument>;
  regionTiles(version: number, region: string): Promise<StoredTile[]>;
  /** Author name and date per pixel index; never the Discord id nor the event id of other users. */
  tileAuthors(version: number, tx: number, ty: number): Promise<Record<string, PixelAuthor>>;
  user(uid: string): Promise<UserReadState>;
}

export class StoredDataError extends Error {
  constructor(message: string) { super(message); this.name = 'StoredDataError'; }
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const timestamp = (value: unknown): TimestampValue => {
  if (!record(value)) throw new StoredDataError('Missing timestamp');
  const result = { seconds: value.seconds as number, nanoseconds: value.nanoseconds as number };
  try { validateTimestamp(result); } catch { throw new StoredDataError('Invalid timestamp'); }
  return result;
};

export function createFirestoreTileStore(db: Firestore, options: { root?: string } = {}): TileStore {
  const path = (value: string) => options.root ? `${options.root}/${value}` : value;
  return {
    async config() {
      const snapshot = await db.doc(path(`${COLLECTIONS.config}/global`)).get();
      const data = snapshot.data();
      // DATA-02 treats a missing configuration as a technical failure: never invent defaults.
      if (!record(data)) throw new StoredDataError('Global configuration is missing');
      try { assertCanvasVersion(data.canvas_version as number); } catch { throw new StoredDataError('Invalid canvas_version'); }
      return data as unknown as GlobalConfigDocument;
    },

    async regionTiles(version, region) {
      // Composite index tile_colors(canvas_version, region), infra/serverless/firestore.tf.
      const snapshot = await db.collection(path(COLLECTIONS.colors))
        .where('canvas_version', '==', version).where('region', '==', region).get();
      return snapshot.docs.map((document) => {
        const data = document.data();
        const { tx, ty } = data;
        try {
          if (document.id !== tileId(version, tx, ty) || tileRegionId(tx, ty) !== region) throw new Error();
          // Firestore returns Buffer values: copy instead of sharing snapshot memory.
          const colors = Uint8Array.from(data.colors as Uint8Array);
          validateTileColors(colors);
          return { tx, ty, colors };
        } catch { throw new StoredDataError('Inconsistent tile document'); }
      });
    },

    async tileAuthors(version, tx, ty) {
      const snapshot = await db.doc(path(`${COLLECTIONS.metadata}/${tileId(version, tx, ty)}`)).get();
      const data = snapshot.data();
      if (data === undefined) return {};
      if (data.canvas_version !== version || data.tx !== tx || data.ty !== ty || !record(data.pixels)) {
        throw new StoredDataError('Inconsistent tile metadata');
      }
      const authors: Record<string, PixelAuthor> = {};
      for (const [index, pixel] of Object.entries(data.pixels)) {
        if (!/^(0|[1-9][0-9]{0,3})$/.test(index) || Number(index) >= 4096 || !record(pixel) || typeof pixel.name !== 'string') {
          throw new StoredDataError('Invalid pixel metadata');
        }
        authors[index] = { name: pixel.name, at: timestamp(pixel.at) };
      }
      return authors;
    },

    async user(uid) {
      const [usage, override] = await db.getAll(
        db.doc(path(`${COLLECTIONS.users}/${uid}`)), db.doc(path(`${COLLECTIONS.overrides}/${uid}`)));
      return {
        usage: (usage.data() as UserStateDocument | undefined) ?? null,
        override: (override.data() as RateLimitOverrideDocument | undefined) ?? null,
      };
    },
  };
}
