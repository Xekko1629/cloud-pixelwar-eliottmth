import { TILE_PIXELS, TILE_SIDE } from '../grid/constants';
import { validateTileColors } from '../grid/batch';
import { encodeIndexedPng, storedColorToPngIndex, type IndexedImage } from './png';

// One tile as a palette image: painted pixels at their colour, untouched pixels white.
// Composition (DATA-05b) copies these indices into a larger image before encoding.
export function tileToIndexedImage(colors: Uint8Array): IndexedImage {
  validateTileColors(colors);
  const indices = new Uint8Array(TILE_PIXELS);
  for (let i = 0; i < TILE_PIXELS; i += 1) indices[i] = storedColorToPngIndex(colors[i]);
  return { width: TILE_SIDE, height: TILE_SIDE, indices };
}

// A missing tile document is an untouched tile: pass emptyTileColors().
export function renderTilePng(colors: Uint8Array): Uint8Array {
  return encodeIndexedPng(tileToIndexedImage(colors));
}
