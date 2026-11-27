import { Timestamp, type Firestore } from '@google-cloud/firestore';
import type { Storage } from '@google-cloud/storage';
import {
  COLLECTIONS, assertCanvasVersion, tileId, tileRegionId, validateGridSize, validateTileColors, type GridSize,
} from '@pixelwar/shared/grid';

export interface OverviewConfig { canvas_version: number; size: GridSize | null }
export interface StoredTile { tx: number; ty: number; colors: Uint8Array }

/** Read-only Firestore port: the runtime identity only has roles/datastore.viewer. */
export interface OverviewStore {
  config(): Promise<OverviewConfig>;
  /** Regions of the deltas created at or after sinceMs (ADR-0003: one delta per region and transaction). */
  changedRegions(version: number, sinceMs: number): Promise<Set<string>>;
  /** Every region holding at least one tile: the full rebuild. */
  paintedRegions(version: number): Promise<Set<string>>;
  regionTiles(version: number, region: string): Promise<StoredTile[]>;
}

export interface OverviewState {
  schema_version: 1;
  canvas_version: number;
  /** Start time of the last cycle: the next one reads the deltas from there (minus an overlap). */
  cursor_ms: number;
  /** Regions left for the next cycles (at most maxRegions per cycle). */
  pending: string[];
}

/** Port on the private overview bucket (SRV-07); the identity only has objectAdmin on it. */
export interface OverviewBucket {
  read(name: string): Promise<Uint8Array | null>;
  write(name: string, png: Uint8Array): Promise<void>;
  remove(name: string): Promise<void>;
  removePrefix(prefix: string): Promise<void>;
  readState(): Promise<{ state: OverviewState | null; generation: string }>;
  /** Fails with ConcurrentCycleError when another cycle wrote the state since readState. */
  writeState(state: OverviewState, generation: string): Promise<void>;
}

export class StoredDataError extends Error {
  constructor(message: string) { super(message); this.name = 'StoredDataError'; }
}
export class ConcurrentCycleError extends Error {
  constructor() { super('Another overview cycle updated the state'); this.name = 'ConcurrentCycleError'; }
}

export const STATE_OBJECT = 'state.json';
const REGION = /^(0|-?[1-9][0-9]{0,6})_(0|-?[1-9][0-9]{0,6})$/;
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value);

export function parseState(value: unknown): OverviewState {
  if (!record(value) || value.schema_version !== 1 || !integer(value.canvas_version) || value.canvas_version < 1 ||
      !integer(value.cursor_ms) || value.cursor_ms < 0 || !Array.isArray(value.pending) ||
      !value.pending.every((region) => typeof region === 'string' && REGION.test(region))) {
    throw new StoredDataError('Invalid overview state');
  }
  return { schema_version: 1, canvas_version: value.canvas_version, cursor_ms: value.cursor_ms, pending: [...value.pending] };
}

export function createFirestoreOverviewStore(db: Firestore, options: { root?: string } = {}): OverviewStore {
  const path = (value: string) => options.root ? `${options.root}/${value}` : value;
  const region = (value: unknown): string => {
    if (typeof value !== 'string' || !REGION.test(value)) throw new StoredDataError('Invalid region');
    return value;
  };
  return {
    async config() {
      const data = (await db.doc(path(`${COLLECTIONS.config}/global`)).get()).data();
      // A missing configuration is a technical failure (DATA-02): never invent defaults.
      if (!record(data)) throw new StoredDataError('Global configuration is missing');
      try {
        assertCanvasVersion(data.canvas_version as number);
        const size = data.size === null ? null : { width: (data.size as GridSize).width, height: (data.size as GridSize).height };
        validateGridSize(size);
        return { canvas_version: data.canvas_version as number, size };
      } catch { throw new StoredDataError('Invalid global configuration'); }
    },
    async changedRegions(version, sinceMs) {
      // Composite index deltas(canvas_version, created_at), the one of the browser listeners.
      const snapshot = await db.collection(path(COLLECTIONS.deltas))
        .where('canvas_version', '==', version).where('created_at', '>=', Timestamp.fromMillis(sinceMs))
        .select('region').get();
      return new Set(snapshot.docs.map((document) => region(document.get('region'))));
    },
    async paintedRegions(version) {
      const query = db.collection(path(COLLECTIONS.colors)).where('canvas_version', '==', version).select('region');
      const regions = new Set<string>();
      for await (const document of query.stream() as AsyncIterable<{ get(field: string): unknown }>) regions.add(region(document.get('region')));
      return regions;
    },
    async regionTiles(version, name) {
      // Composite index tile_colors(canvas_version, region), infra/serverless/firestore.tf.
      const snapshot = await db.collection(path(COLLECTIONS.colors))
        .where('canvas_version', '==', version).where('region', '==', name).select('tx', 'ty', 'colors').get();
      return snapshot.docs.map((document) => {
        const data = document.data();
        const { tx, ty } = data;
        try {
          if (!integer(tx) || !integer(ty) || document.id !== tileId(version, tx, ty) || tileRegionId(tx, ty) !== name) throw new Error();
          // Firestore returns Buffer values: copy instead of sharing snapshot memory.
          const colors = Uint8Array.from(data.colors as Uint8Array);
          validateTileColors(colors);
          return { tx, ty, colors };
        } catch { throw new StoredDataError('Inconsistent tile document'); }
      });
    },
  };
}

const notFound = (error: unknown) => (error as { code?: number }).code === 404;

export function createGcsOverviewBucket(storage: Storage, bucketName: string): OverviewBucket {
  const bucket = storage.bucket(bucketName);
  return {
    async read(name) {
      try { const [data] = await bucket.file(name).download(); return new Uint8Array(data); }
      catch (error) { if (notFound(error)) return null; throw error; }
    },
    async write(name, png) {
      // Rewritten every cycle a region changes: the browser revalidates after one minute.
      await bucket.file(name).save(Buffer.from(png), {
        resumable: false, contentType: 'image/png', metadata: { cacheControl: 'private, max-age=60' },
      });
    },
    async remove(name) { await bucket.file(name).delete({ ignoreNotFound: true }); },
    async removePrefix(prefix) { await bucket.deleteFiles({ prefix, force: true }); },
    async readState() {
      try {
        // Metadata first, then exactly that generation: the state and its generation always match.
        const [metadata] = await bucket.file(STATE_OBJECT).getMetadata();
        const generation = String(metadata.generation);
        const [data] = await bucket.file(STATE_OBJECT, { generation }).download();
        return { state: parseState(JSON.parse(data.toString('utf8'))), generation };
      } catch (error) {
        // Generation 0 means "the object must not exist yet": the first cycle creates it.
        if (notFound(error)) return { state: null, generation: '0' };
        throw error;
      }
    },
    async writeState(state, generation) {
      try {
        await bucket.file(STATE_OBJECT).save(JSON.stringify(state), {
          resumable: false, contentType: 'application/json', preconditionOpts: { ifGenerationMatch: generation },
        });
      } catch (error) {
        if ((error as { code?: number }).code === 412) throw new ConcurrentCycleError();
        throw error;
      }
    },
  };
}
