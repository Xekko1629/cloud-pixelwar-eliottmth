export const TILE_SIDE = 64;
export const TILE_PIXELS = TILE_SIDE * TILE_SIDE;
export const REGION_SIDE = 1024;
export const COORDINATE_LIMIT = 1_000_000_000;
export const DEFAULT_MAX_BATCH_PIXELS = 500;
export const MAX_REGIONS_PER_QUERY = 30;
export const DELTA_ENCODING_VERSION = 1;
export const DELTA_PIXEL_BYTES = 5;
export const FIRESTORE_DOCUMENT_LIMIT = 1024 * 1024;

// Index 0 means untouched; index 1 is a pixel deliberately painted white.
export const PALETTE = Object.freeze([
  '#FFFFFF', '#E4E4E4', '#888888', '#222222',
  '#FFA7D1', '#E50000', '#E59500', '#A06A42',
  '#E5D900', '#94E044', '#02BE01', '#00D3DD',
  '#0083C7', '#0000EA', '#CF6EE4', '#820080',
]);

export function assertInteger(value: number, min: number, max: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be an integer between ${min} and ${max}`);
  }
}

export function assertColor(color: number, allowUntouched = false): void {
  assertInteger(color, allowUntouched ? 0 : 1, PALETTE.length, 'color');
}

export function assertCanvasVersion(version: number): void {
  assertInteger(version, 1, Number.MAX_SAFE_INTEGER, 'canvas_version');
}
