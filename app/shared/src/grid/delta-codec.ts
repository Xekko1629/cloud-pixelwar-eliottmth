import { DEFAULT_MAX_BATCH_PIXELS, DELTA_PIXEL_BYTES, REGION_SIDE, assertColor, assertInteger } from './constants';

export interface RegionPixel { x: number; y: number; color: number }

function validatePixel(pixel: RegionPixel): void {
  assertInteger(pixel.x, 0, REGION_SIDE - 1, 'region x');
  assertInteger(pixel.y, 0, REGION_SIDE - 1, 'region y');
  assertColor(pixel.color);
}

export function encodeDelta(pixels: readonly RegionPixel[], maxPixels = DEFAULT_MAX_BATCH_PIXELS): Uint8Array {
  assertInteger(maxPixels, 1, Number.MAX_SAFE_INTEGER, 'maxPixels');
  assertInteger(pixels.length, 1, maxPixels, 'pixel count');
  const bytes = new Uint8Array(pixels.length * DELTA_PIXEL_BYTES);
  const view = new DataView(bytes.buffer);
  const positions = new Set<number>();
  pixels.forEach((pixel, i) => {
    validatePixel(pixel);
    const position = pixel.y * REGION_SIDE + pixel.x;
    if (positions.has(position)) throw new Error('Duplicate pixel in delta');
    positions.add(position);
    view.setUint16(i * DELTA_PIXEL_BYTES, pixel.x, true);
    view.setUint16(i * DELTA_PIXEL_BYTES + 2, pixel.y, true);
    view.setUint8(i * DELTA_PIXEL_BYTES + 4, pixel.color);
  });
  return bytes;
}

export function decodeDelta(bytes: Uint8Array, maxPixels = DEFAULT_MAX_BATCH_PIXELS): RegionPixel[] {
  assertInteger(maxPixels, 1, Number.MAX_SAFE_INTEGER, 'maxPixels');
  if (bytes.byteLength % DELTA_PIXEL_BYTES !== 0) throw new Error('Delta byte length must be a multiple of 5');
  assertInteger(bytes.byteLength / DELTA_PIXEL_BYTES, 1, maxPixels, 'pixel count');
  // Respect offsets: Firestore Node Buffers and typed-array slices may share a larger buffer.
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const pixels: RegionPixel[] = [];
  const positions = new Set<number>();
  for (let offset = 0; offset < bytes.byteLength; offset += DELTA_PIXEL_BYTES) {
    const pixel = { x: view.getUint16(offset, true), y: view.getUint16(offset + 2, true), color: view.getUint8(offset + 4) };
    validatePixel(pixel);
    const position = pixel.y * REGION_SIDE + pixel.x;
    if (positions.has(position)) throw new Error('Duplicate pixel in delta');
    positions.add(position);
    pixels.push(pixel);
  }
  return pixels;
}
