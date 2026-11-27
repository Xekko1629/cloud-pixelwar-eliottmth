import { REGION_SIDE, TILE_SIDE } from '@pixelwar/shared/grid';
import {
  OVERVIEW_SIDE, overviewArea, overviewObjectName, overviewParent, overviewScale, overviewVersionPrefix,
  type OverviewLevel,
} from '@pixelwar/shared/overview';
import {
  composeArea, decodeIndexedPng, encodeIndexedPng, tileSource, type CellRange, type RasterCell, type RasterSource,
} from '@pixelwar/shared/render';
import type { OverviewBucket, OverviewState, OverviewStore } from './store';

/**
 * A transaction can commit up to 270 s after the time it wrote in created_at (Firestore
 * transaction limit), plus clock skew between workers: every cycle reads the deltas again
 * from 5 minutes before the previous cycle. Re-rendering a region twice changes nothing.
 */
export const DELTA_OVERLAP_MS = 5 * 60_000;
/**
 * Deltas expire after one hour (DATA-02 delta_ttl_ms). Past this horizon, changes may be gone:
 * the cycle rebuilds every painted region instead of trusting the deltas.
 */
export const DELTA_HORIZON_MS = 50 * 60_000;
export const MAX_REGIONS_PER_CYCLE = 64;

export interface CycleOptions {
  store: OverviewStore;
  bucket: OverviewBucket;
  now: () => number;
  maxRegions?: number;
}

export interface CycleSummary {
  mode: 'incremental' | 'full';
  canvas_version: number;
  rendered: Record<OverviewLevel, number>;
  removed: number;
  pending: number;
}

const TILES_PER_REGION = REGION_SIDE / TILE_SIDE;
const parseRegion = (region: string) => { const [rx, ry] = region.split('_').map(Number); return { rx, ry }; };
const key = (cx: number, cy: number) => `${cx}_${cy}`;
// Same order on every run: a region left pending is never starved by newer ones.
const byPosition = (a: string, b: string) => {
  const p = parseRegion(a); const q = parseRegion(b);
  return p.ry - q.ry || p.rx - q.rx;
};

/** Images of the level below, read back from the bucket: level 2 and 3 never read Firestore. */
function levelSource(bucket: OverviewBucket, version: number, level: OverviewLevel): RasterSource {
  return {
    scale: overviewScale(level),
    side: OVERVIEW_SIDE,
    async *load(range: CellRange) {
      const names: { cx: number; cy: number; name: string }[] = [];
      for (let cy = range.min_cy; cy <= range.max_cy; cy += 1) {
        for (let cx = range.min_cx; cx <= range.max_cx; cx += 1) names.push({ cx, cy, name: overviewObjectName(version, level, cx, cy) });
      }
      const images = await Promise.all(names.map(async (cell) => ({ ...cell, png: await bucket.read(cell.name) })));
      for (const image of images) {
        if (!image.png) continue; // A missing image is an empty area.
        const decoded = decodeIndexedPng(image.png, OVERVIEW_SIDE);
        if (decoded.width !== OVERVIEW_SIDE || decoded.height !== OVERVIEW_SIDE) throw new Error('Overview image of unexpected size');
        yield { cx: image.cx, cy: image.cy, indices: decoded.indices } satisfies RasterCell;
      }
    },
  };
}

/** Renders one cell; an area with nothing painted removes its image instead of storing a blank one. */
async function renderCell(bucket: OverviewBucket, version: number, level: OverviewLevel, cx: number, cy: number, source: RasterSource) {
  let painted = false;
  const watched: RasterSource = {
    ...source,
    async *load(range) { for await (const cell of source.load(range)) { painted = true; yield cell; } },
  };
  // One image side of 256 pixels: composeArea then picks exactly the scale of the level.
  const cells = level === 1 ? TILES_PER_REGION ** 2 : 16;
  const { image } = await composeArea(overviewArea(level, cx, cy), [watched], { maxSide: OVERVIEW_SIDE, maxCells: cells });
  const name = overviewObjectName(version, level, cx, cy);
  if (!painted) { await bucket.remove(name); return 'removed' as const; }
  await bucket.write(name, encodeIndexedPng(image));
  return 'rendered' as const;
}

/**
 * One cycle of the overview-worker (DATA-05c, option B of 26/11): the changed regions come from
 * the deltas, not from a consumer of pixel-processed. Level 1 is rendered from the tiles of each
 * region, then levels 2 and 3 from the images below them.
 */
export async function runOverviewCycle(options: CycleOptions): Promise<CycleSummary> {
  const maxRegions = options.maxRegions ?? MAX_REGIONS_PER_CYCLE;
  const started = options.now();
  const config = await options.store.config();
  const version = config.canvas_version;
  const { state, generation } = await options.bucket.readState();

  const full = !state || state.canvas_version !== version || started - state.cursor_ms > DELTA_HORIZON_MS;
  let regions: Set<string>;
  if (full) {
    // After /admin clear the version changes: images of the old one are never served again.
    if (state && state.canvas_version !== version) await options.bucket.removePrefix(overviewVersionPrefix(state.canvas_version));
    regions = await options.store.paintedRegions(version);
  } else {
    regions = new Set([...state.pending, ...await options.store.changedRegions(version, state.cursor_ms - DELTA_OVERLAP_MS)]);
  }

  const ordered = [...regions].sort(byPosition);
  const batch = ordered.slice(0, maxRegions);
  const summary: CycleSummary = {
    mode: full ? 'full' : 'incremental', canvas_version: version, rendered: { 1: 0, 2: 0, 3: 0 }, removed: 0,
    pending: ordered.length - batch.length,
  };
  const count = (outcome: 'rendered' | 'removed', level: OverviewLevel) => {
    if (outcome === 'rendered') summary.rendered[level] += 1; else summary.removed += 1;
  };

  for (const region of batch) {
    const { rx, ry } = parseRegion(region);
    const tiles = await options.store.regionTiles(version, region);
    count(await renderCell(options.bucket, version, 1, rx, ry, tileSource(async function* () { yield* tiles; })), 1);
  }
  for (const level of [2, 3] as const) {
    const cells = new Map<string, { cx: number; cy: number }>();
    for (const region of batch) {
      const { rx, ry } = parseRegion(region);
      const cell = overviewParent(level, rx, ry);
      cells.set(key(cell.cx, cell.cy), cell);
    }
    for (const { cx, cy } of cells.values()) {
      count(await renderCell(options.bucket, version, level, cx, cy, levelSource(options.bucket, version, (level - 1) as OverviewLevel)), level);
    }
  }

  // Written last: a cycle that fails midway is simply done again by the next tick.
  const next: OverviewState = { schema_version: 1, canvas_version: version, cursor_ms: started, pending: ordered.slice(maxRegions) };
  await options.bucket.writeState(next, generation);
  return summary;
}
