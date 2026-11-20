import { crc32, inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { PALETTE, TILE_PIXELS, TILE_SIDE, emptyTileColors } from '../grid';
import { encodeIndexedPng, renderTilePng, storedColorToPngIndex, tileToIndexedImage } from '.';

interface DecodedPng { width: number; height: number; bitDepth: number; colorType: number; rgb: string[] }

// Minimal independent reader for the subset the encoder writes: indexed, no filter.
function decodePng(png: Uint8Array): DecodedPng {
  expect(Array.from(png.subarray(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const chunks: { type: string; data: Uint8Array }[] = [];
  let offset = 8;
  while (offset < png.byteLength) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...png.subarray(offset + 4, offset + 8));
    const data = png.subarray(offset + 8, offset + 8 + length);
    expect(view.getUint32(offset + 8 + length)).toBe(crc32(png.subarray(offset + 4, offset + 8 + length)));
    chunks.push({ type, data });
    offset += 12 + length;
  }
  expect(chunks.map((c) => c.type)).toEqual(['IHDR', 'PLTE', 'IDAT', 'IEND']);

  const header = new DataView(chunks[0].data.buffer, chunks[0].data.byteOffset, 13);
  const width = header.getUint32(0);
  const height = header.getUint32(4);
  const bitDepth = chunks[0].data[8];
  const colorType = chunks[0].data[9];
  const palette = chunks[1].data;
  const raw = inflateSync(chunks[2].data);
  const rowBytes = Math.ceil((width * bitDepth) / 8);
  expect(raw.byteLength).toBe((rowBytes + 1) * height);

  const rgb: string[] = [];
  for (let y = 0; y < height; y += 1) {
    const row = y * (rowBytes + 1);
    expect(raw[row]).toBe(0);
    for (let x = 0; x < width; x += 1) {
      const byte = raw[row + 1 + (x >> 1)];
      const entry = x % 2 === 0 ? byte >> 4 : byte & 0x0f;
      const [r, g, b] = palette.subarray(entry * 3, entry * 3 + 3);
      rgb.push(`#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('').toUpperCase()}`);
    }
  }
  return { width, height, bitDepth, colorType, rgb };
}

describe('renderTilePng', () => {
  it('renders an empty tile as a white 64×64 image', () => {
    const image = decodePng(renderTilePng(emptyTileColors()));

    expect(image).toMatchObject({ width: TILE_SIDE, height: TILE_SIDE, bitDepth: 4, colorType: 3 });
    expect(image.rgb).toHaveLength(TILE_PIXELS);
    expect(new Set(image.rgb)).toEqual(new Set(['#FFFFFF']));
  });

  it('renders a full tile with every pixel at its palette colour', () => {
    const colors = new Uint8Array(TILE_PIXELS).map((_, i) => (i % PALETTE.length) + 1);

    const image = decodePng(renderTilePng(colors));

    expect(image.rgb).toEqual(Array.from(colors, (color) => PALETTE[color - 1]));
    expect(new Set(image.rgb).size).toBe(PALETTE.length);
  });

  it('renders a partial tile: painted pixels coloured, untouched pixels white', () => {
    const colors = emptyTileColors();
    colors[0] = 6; // red, top-left
    colors[63] = 14; // blue, end of the first row
    colors[64] = 4; // dark grey, start of the second row
    colors[TILE_PIXELS - 1] = 1; // painted white, bottom-right

    const image = decodePng(renderTilePng(colors));

    expect(image.rgb[0]).toBe('#E50000');
    expect(image.rgb[63]).toBe('#0000EA');
    expect(image.rgb[64]).toBe('#222222');
    expect(image.rgb[TILE_PIXELS - 1]).toBe('#FFFFFF');
    const painted = new Set([0, 63, 64, TILE_PIXELS - 1]);
    expect(image.rgb.every((rgb, i) => painted.has(i) || rgb === '#FFFFFF')).toBe(true);
  });

  it('keeps an empty tile small', () => {
    expect(renderTilePng(emptyTileColors()).byteLength).toBeLessThan(200);
  });

  it('rejects invalid tile colours', () => {
    expect(() => renderTilePng(new Uint8Array(TILE_PIXELS - 1))).toThrow('4096 bytes');
    const colors = emptyTileColors();
    colors[10] = PALETTE.length + 1;
    expect(() => renderTilePng(colors)).toThrow(RangeError);
  });
});

describe('tileToIndexedImage', () => {
  it('maps untouched and painted white to the same white entry', () => {
    const colors = emptyTileColors();
    colors[1] = 1;
    colors[2] = 16;

    const { width, height, indices } = tileToIndexedImage(colors);

    expect([width, height]).toEqual([TILE_SIDE, TILE_SIDE]);
    expect(Array.from(indices.subarray(0, 3))).toEqual([0, 0, 15]);
  });
});

describe('storedColorToPngIndex', () => {
  it('shifts painted colours and rejects out-of-palette values', () => {
    expect(storedColorToPngIndex(0)).toBe(0);
    expect(storedColorToPngIndex(1)).toBe(0);
    expect(storedColorToPngIndex(16)).toBe(15);
    expect(() => storedColorToPngIndex(17)).toThrow(RangeError);
    expect(() => storedColorToPngIndex(-1)).toThrow(RangeError);
  });
});

describe('encodeIndexedPng', () => {
  it('packs an odd width, padding the last nibble of each row', () => {
    const image = decodePng(encodeIndexedPng({ width: 3, height: 2, indices: Uint8Array.of(5, 0, 12, 15, 3, 0) }));

    expect([image.width, image.height]).toEqual([3, 2]);
    expect(image.rgb).toEqual([PALETTE[5], PALETTE[0], PALETTE[12], PALETTE[15], PALETTE[3], PALETTE[0]]);
  });

  it('rejects mismatched sizes, empty sides and indices outside the palette', () => {
    expect(() => encodeIndexedPng({ width: 2, height: 2, indices: new Uint8Array(3) })).toThrow('width × height');
    expect(() => encodeIndexedPng({ width: 0, height: 1, indices: new Uint8Array(0) })).toThrow(RangeError);
    expect(() => encodeIndexedPng({ width: 1, height: 1, indices: Uint8Array.of(16) })).toThrow('between 0 and 15');
  });
});
