import { crc32, deflateSync, inflateSync } from 'node:zlib';
import { PALETTE, assertInteger } from '../grid/constants';

// Node only (zlib): used by the workers that render images, never by the frontend.

const SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const COLOR_TYPE_INDEXED = 3;
const BIT_DEPTH = 4;
// PNG caps both dimensions at 2^31 - 1; the workers bound images far below (DATA-05b).
const MAX_SIDE = 2 ** 31 - 1;

// The 16 palette colours are the 16 PNG entries: 4 bits per pixel.
export const PNG_PALETTE_SIZE = PALETTE.length;

// A palette image: one PNG palette index (0-15) per pixel, row by row.
export interface IndexedImage {
  width: number;
  height: number;
  indices: Uint8Array;
}

// Stored colour 0 (never painted) is shown white, like palette entry 1 (#FFFFFF).
export function storedColorToPngIndex(color: number): number {
  assertInteger(color, 0, PALETTE.length, 'color');
  return color === 0 ? 0 : color - 1;
}

function paletteBytes(): Uint8Array {
  const bytes = new Uint8Array(PALETTE.length * 3);
  PALETTE.forEach((hex, entry) => {
    for (let channel = 0; channel < 3; channel += 1) {
      bytes[entry * 3 + channel] = Number.parseInt(hex.slice(1 + channel * 2, 3 + channel * 2), 16);
    }
  });
  return bytes;
}

const PLTE = paletteBytes();

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.byteLength);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.byteLength);
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.byteLength, crc32(out.subarray(4, 8 + data.byteLength)));
  return out;
}

// Scanlines with filter type 0 (none): two 4-bit pixels per byte, high nibble first.
function scanlines(image: IndexedImage): Uint8Array {
  const rowBytes = Math.ceil(image.width / 2);
  const raw = new Uint8Array((rowBytes + 1) * image.height);
  for (let y = 0; y < image.height; y += 1) {
    const row = y * (rowBytes + 1) + 1;
    const source = y * image.width;
    for (let x = 0; x < image.width; x += 1) {
      const index = image.indices[source + x];
      raw[row + (x >> 1)] |= x % 2 === 0 ? index << 4 : index;
    }
  }
  return raw;
}

export function validateIndexedImage(image: IndexedImage): void {
  assertInteger(image.width, 1, MAX_SIDE, 'width');
  assertInteger(image.height, 1, MAX_SIDE, 'height');
  if (image.indices.byteLength !== image.width * image.height) {
    throw new Error('Image indices must contain width × height entries');
  }
  for (const index of image.indices) {
    if (index >= PNG_PALETTE_SIZE) throw new RangeError(`PNG index must be between 0 and ${PNG_PALETTE_SIZE - 1}`);
  }
}

export function encodeIndexedPng(image: IndexedImage): Uint8Array {
  validateIndexedImage(image);
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, image.width);
  view.setUint32(4, image.height);
  header.set([BIT_DEPTH, COLOR_TYPE_INDEXED, 0, 0, 0], 8);

  const parts = [
    SIGNATURE,
    chunk('IHDR', header),
    chunk('PLTE', PLTE),
    chunk('IDAT', deflateSync(scanlines(image))),
    chunk('IEND', new Uint8Array(0)),
  ];
  const png = new Uint8Array(parts.reduce((size, part) => size + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    png.set(part, offset);
    offset += part.byteLength;
  }
  return png;
}

export class InvalidPngError extends Error {
  constructor(message: string) { super(message); this.name = 'InvalidPngError'; }
}

/**
 * Reads back a PNG written by encodeIndexedPng, and only that format: 4-bit indexed
 * colour, our 16-entry palette, filter type 0, no interlace. The far-view pyramid
 * (DATA-05c) builds each level from the images of the level below.
 */
export function decodeIndexedPng(png: Uint8Array, maxSide = 4096): IndexedImage {
  const fail = (reason: string): never => { throw new InvalidPngError(`Unsupported PNG: ${reason}`); };
  if (png.byteLength < SIGNATURE.byteLength || SIGNATURE.some((byte, i) => png[i] !== byte)) fail('signature');
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let offset = SIGNATURE.byteLength;
  let width = 0;
  let height = 0;
  const data: Uint8Array[] = [];
  let ended = false;
  while (offset < png.byteLength && !ended) {
    if (offset + 12 > png.byteLength) fail('truncated chunk');
    const length = view.getUint32(offset);
    if (offset + 12 + length > png.byteLength) fail('truncated chunk');
    const type = String.fromCharCode(...png.subarray(offset + 4, offset + 8));
    const body = png.subarray(offset + 8, offset + 8 + length);
    if (view.getUint32(offset + 8 + length) !== crc32(png.subarray(offset + 4, offset + 8 + length))) fail('CRC');
    if (type === 'IHDR') {
      if (length !== 13) fail('header');
      width = view.getUint32(offset + 8);
      height = view.getUint32(offset + 12);
      if (body[8] !== BIT_DEPTH || body[9] !== COLOR_TYPE_INDEXED || body[10] !== 0 || body[11] !== 0 || body[12] !== 0) fail('format');
    } else if (type === 'PLTE') {
      if (length !== PLTE.byteLength || PLTE.some((byte, i) => body[i] !== byte)) fail('palette');
    } else if (type === 'IDAT') {
      data.push(body);
    } else if (type === 'IEND') {
      ended = true;
    }
    offset += 12 + length;
  }
  if (!ended || width < 1 || height < 1 || width > maxSide || height > maxSide || data.length === 0) fail('structure');
  const rowBytes = Math.ceil(width / 2);
  let raw: Uint8Array;
  try { raw = inflateSync(Buffer.concat(data), { maxOutputLength: (rowBytes + 1) * height }); } catch { return fail('data'); }
  if (raw.byteLength !== (rowBytes + 1) * height) fail('data length');
  const indices = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (rowBytes + 1);
    if (raw[row] !== 0) fail('filter');
    for (let x = 0; x < width; x += 1) {
      const byte = raw[row + 1 + (x >> 1)];
      indices[y * width + x] = x % 2 === 0 ? byte >> 4 : byte & 0x0f;
    }
  }
  return { width, height, indices };
}
