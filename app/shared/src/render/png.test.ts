import { describe, expect, it } from 'vitest';
import { decodePng } from '../../../testing/png-reader';
import { PALETTE, TILE_PIXELS, TILE_SIDE, emptyTileColors } from '../grid';
import { InvalidPngError, decodeIndexedPng, encodeIndexedPng, renderTilePng, storedColorToPngIndex, tileToIndexedImage } from '.';

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

describe('decodeIndexedPng', () => {
  it('reads back what encodeIndexedPng wrote, odd widths included', () => {
    for (const [width, height] of [[1, 1], [3, 2], [256, 256]]) {
      const indices = Uint8Array.from({ length: width * height }, (_, i) => (i * 7) % 16);
      expect(decodeIndexedPng(encodeIndexedPng({ width, height, indices }))).toEqual({ width, height, indices });
    }
  });
  it('refuses any other PNG, a corrupt one or one larger than allowed', () => {
    const png = encodeIndexedPng({ width: 4, height: 4, indices: new Uint8Array(16) });
    const corrupt = Uint8Array.from(png); corrupt[corrupt.length - 20] ^= 0xff;
    const signature = Uint8Array.from(png); signature[0] = 0;
    const header = Uint8Array.from(png); header[24] = 8; // Bit depth 8 instead of 4.
    for (const bad of [corrupt, signature, header, png.subarray(0, 40), new Uint8Array(3)]) {
      expect(() => decodeIndexedPng(bad)).toThrow(InvalidPngError);
    }
    expect(() => decodeIndexedPng(png, 2)).toThrow('structure');
  });
});
