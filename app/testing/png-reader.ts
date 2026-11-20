import { crc32, inflateSync } from 'node:zlib';

// Minimal reader, independent of the encoder, for the subset it writes:
// 4-bit indexed PNG without filters. Pixels come back as #RRGGBB, row by row.
export interface DecodedPng { width: number; height: number; bitDepth: number; colorType: number; rgb: string[] }

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Invalid PNG: ${message}`);
}

export function decodePng(png: Uint8Array): DecodedPng {
  check(SIGNATURE.every((byte, i) => png[i] === byte), 'signature');
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const chunks: { type: string; data: Uint8Array }[] = [];
  let offset = 8;
  while (offset < png.byteLength) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...png.subarray(offset + 4, offset + 8));
    const data = png.subarray(offset + 8, offset + 8 + length);
    check(view.getUint32(offset + 8 + length) === crc32(png.subarray(offset + 4, offset + 8 + length)), `${type} CRC`);
    chunks.push({ type, data });
    offset += 12 + length;
  }
  check(chunks.map((c) => c.type).join() === 'IHDR,PLTE,IDAT,IEND', 'chunk order');

  const header = new DataView(chunks[0].data.buffer, chunks[0].data.byteOffset, 13);
  const width = header.getUint32(0);
  const height = header.getUint32(4);
  const bitDepth = chunks[0].data[8];
  const colorType = chunks[0].data[9];
  check(bitDepth === 4 && colorType === 3, 'expected a 4-bit indexed image');
  const palette = chunks[1].data;
  const raw = inflateSync(chunks[2].data);
  const rowBytes = Math.ceil(width / 2);
  check(raw.byteLength === (rowBytes + 1) * height, 'scanline length');

  const rgb: string[] = [];
  for (let y = 0; y < height; y += 1) {
    const row = y * (rowBytes + 1);
    check(raw[row] === 0, 'filter type');
    for (let x = 0; x < width; x += 1) {
      const byte = raw[row + 1 + (x >> 1)];
      const entry = x % 2 === 0 ? byte >> 4 : byte & 0x0f;
      const [r, g, b] = palette.subarray(entry * 3, entry * 3 + 3);
      rgb.push(`#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('').toUpperCase()}`);
    }
  }
  return { width, height, bitDepth, colorType, rgb };
}
