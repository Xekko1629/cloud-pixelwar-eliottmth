import type { Firestore } from '@google-cloud/firestore';
import {
  COLLECTIONS, assertCanvasVersion, tileId, validateGridSize, validateTileColors, type Bounds, type GridSize,
} from '../grid';
import {
  GET_RENDER_OPTIONS, RenderTooLargeError, renderAreaPng, tileSource, type CellRange, type RenderOptions, type RenderedArea,
} from './compose';

// Node only, with Firestore: rendering of the painted area shared by /get (render-worker)
// and /snapshot (snapshot-worker). Kept out of ./render, which has no Firestore dependency.

/** What /get shows: the painted area (ADR-0007), nothing painted yet, or an area beyond the read budget. */
export type RenderResult =
  | { kind: 'image'; image: RenderedArea; canvas_version: number }
  | { kind: 'empty' }
  | { kind: 'too_large'; cells: number };

export interface RenderConfig { canvas_version: number; size: GridSize | null; bounds: Bounds | null }
export interface StoredTile { tx: number; ty: number; colors: Uint8Array }
/** Read-only port: the runtime identity only has roles/datastore.viewer. */
export interface RenderStore {
  config(): Promise<RenderConfig>;
  /** Tiles of one canvas version; the renderer keeps those of the requested range. */
  tiles(version: number): AsyncIterable<StoredTile>;
}

export class StoredDataError extends Error {
  constructor(message: string) { super(message); this.name = 'StoredDataError'; }
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value);

function parseBounds(value: unknown): Bounds | null {
  if (value === null) return null;
  if (!record(value) || !integer(value.min_x) || !integer(value.min_y) || !integer(value.max_x) || !integer(value.max_y)) {
    throw new StoredDataError('Invalid bounds');
  }
  return { min_x: value.min_x, min_y: value.min_y, max_x: value.max_x, max_y: value.max_y };
}

export function createFirestoreRenderStore(db: Firestore, options: { root?: string } = {}): RenderStore {
  const path = (value: string) => options.root ? `${options.root}/${value}` : value;
  return {
    async config() {
      const data = (await db.doc(path(`${COLLECTIONS.config}/global`)).get()).data();
      // A missing configuration is a technical failure (DATA-02): never invent defaults.
      if (!record(data)) throw new StoredDataError('Global configuration is missing');
      try {
        assertCanvasVersion(data.canvas_version as number);
        const size = data.size === null ? null : { width: (data.size as GridSize).width, height: (data.size as GridSize).height };
        validateGridSize(size);
        return { canvas_version: data.canvas_version as number, size, bounds: parseBounds(data.bounds) };
      } catch (error) {
        throw error instanceof StoredDataError ? error : new StoredDataError('Invalid global configuration');
      }
    },
    async *tiles(version) {
      // Single-field index on canvas_version; colors is exempted from indexing, not from reads.
      const query = db.collection(path(COLLECTIONS.colors)).where('canvas_version', '==', version).select('tx', 'ty', 'colors');
      for await (const document of query.stream() as AsyncIterable<{ id: string; data(): Record<string, unknown> }>) {
        const data = document.data();
        const { tx, ty } = data;
        try {
          if (!integer(tx) || !integer(ty) || document.id !== tileId(version, tx, ty)) throw new Error();
          // Firestore returns Buffer values: copy instead of sharing snapshot memory.
          const colors = Uint8Array.from(data.colors as Uint8Array);
          validateTileColors(colors);
          yield { tx, ty, colors };
        } catch { throw new StoredDataError('Inconsistent tile document'); }
      }
    },
  };
}

/**
 * Renders the painted area of the current canvas version (DATA-05b). Tiles outside the range
 * (pixels left outside a reduced grid) are skipped but still counted: reads stay within maxCells.
 */
export async function renderCanvas(store: RenderStore, options: RenderOptions = GET_RENDER_OPTIONS): Promise<RenderResult> {
  const config = await store.config();
  const source = tileSource(async function* (range: CellRange) {
    let reads = 0;
    for await (const tile of store.tiles(config.canvas_version)) {
      reads += 1;
      if (reads > options.maxCells) throw new RenderTooLargeError(reads, options.maxCells);
      if (tile.tx >= range.min_cx && tile.tx <= range.max_cx && tile.ty >= range.min_cy && tile.ty <= range.max_cy) yield tile;
    }
  });
  try {
    const image = await renderAreaPng(config.bounds, config.size, [source], options);
    return image === null ? { kind: 'empty' } : { kind: 'image', image, canvas_version: config.canvas_version };
  } catch (error) {
    if (error instanceof RenderTooLargeError) return { kind: 'too_large', cells: error.cells };
    throw error;
  }
}
