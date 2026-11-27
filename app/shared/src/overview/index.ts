import { COORDINATE_LIMIT, REGION_SIDE, assertCanvasVersion, assertInteger } from '../grid/constants';
import type { Bounds } from '../grid/coordinates';

// Far-view pyramid (ADR-0007, DATA-05c): 256×256 images on 3 levels, only where something is
// painted. Level 1 covers one region, level 2 4×4 regions, level 3 16×16 regions.
// Pure geometry: shared by the overview-worker (writes) and the tile-reader (signed URLs).

export const OVERVIEW_SIDE = 256;
export const OVERVIEW_LEVELS = [1, 2, 3] as const;
export type OverviewLevel = (typeof OVERVIEW_LEVELS)[number];

/** Grid pixels per image pixel: 4, 16 and 64. */
export function overviewScale(level: OverviewLevel): number {
  return 4 ** level;
}

/** Grid pixels covered by one image side: 1024, 4096 and 16384. */
export function overviewSpan(level: OverviewLevel): number {
  return OVERVIEW_SIDE * overviewScale(level);
}

export function isOverviewLevel(value: unknown): value is OverviewLevel {
  return value === 1 || value === 2 || value === 3;
}

export function assertOverviewCell(level: OverviewLevel, cx: number, cy: number): void {
  if (!isOverviewLevel(level)) throw new RangeError('level must be 1, 2 or 3');
  const span = overviewSpan(level);
  const min = Math.floor(-COORDINATE_LIMIT / span);
  const max = Math.floor(COORDINATE_LIMIT / span);
  assertInteger(cx, min, max, 'cx');
  assertInteger(cy, min, max, 'cy');
}

/** Cell of a level that contains a level-1 cell (a region). */
export function overviewParent(level: OverviewLevel, rx: number, ry: number): { cx: number; cy: number } {
  const factor = overviewSpan(level) / REGION_SIDE;
  return { cx: Math.floor(rx / factor), cy: Math.floor(ry / factor) };
}

/** Inclusive grid rectangle covered by a cell. */
export function overviewArea(level: OverviewLevel, cx: number, cy: number): Bounds {
  assertOverviewCell(level, cx, cy);
  const span = overviewSpan(level);
  return { min_x: cx * span, min_y: cy * span, max_x: (cx + 1) * span - 1, max_y: (cy + 1) * span - 1 };
}

/** Object of a cell in the overview bucket. Versioned: after /admin clear, old images are never served. */
export function overviewObjectName(version: number, level: OverviewLevel, cx: number, cy: number): string {
  assertCanvasVersion(version);
  assertOverviewCell(level, cx, cy);
  return `v${version}/${level}/${cx}_${cy}.png`;
}

export function overviewVersionPrefix(version: number): string {
  assertCanvasVersion(version);
  return `v${version}/`;
}
