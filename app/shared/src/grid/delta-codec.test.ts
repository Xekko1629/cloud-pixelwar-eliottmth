import { describe, expect, it } from 'vitest';
import { decodeDelta, encodeDelta, type RegionPixel } from './delta-codec';

const pixel = (x: number, y: number, colour: number): RegionPixel => ({ x, y, color: colour });

describe('encodeDelta', () => {
  it('writes little-endian x and y followed by the colour', () => {
    expect(encodeDelta([pixel(0x0102, 0x0304, 5)])).toEqual(new Uint8Array([0x02, 0x01, 0x04, 0x03, 0x05]));
  });

  it('uses five bytes per pixel', () => {
    expect(encodeDelta([pixel(0, 0, 1), pixel(1_023, 1_023, 16)])).toHaveLength(10);
  });

  it('encodes the maximum region coordinates', () => {
    expect(decodeDelta(encodeDelta([pixel(1_023, 1_023, 16)]))).toEqual([pixel(1_023, 1_023, 16)]);
  });

  it('preserves order and duplicates colours across positions', () => {
    const pixels = [pixel(0, 0, 1), pixel(1_023, 0, 16), pixel(0, 1_023, 8)];
    expect(decodeDelta(encodeDelta(pixels))).toEqual(pixels);
  });
});

describe('decodeDelta', () => {
  it('round-trips a full batch', () => {
    const pixels = Array.from({ length: 500 }, (_, i) => pixel(i % 1_024, Math.floor(i / 1_024), (i % 16) + 1));
    expect(decodeDelta(encodeDelta(pixels))).toEqual(pixels);
  });

  it('honours the view offset of a subarray', () => {
    const encoded = encodeDelta([pixel(3, 4, 5)]);
    const storage = new Uint8Array(encoded.length + 4);
    storage.set(encoded, 2);
    expect(decodeDelta(storage.subarray(2, 2 + encoded.length))).toEqual([pixel(3, 4, 5)]);
  });

  it.each([
    ['an invalid x', new Uint8Array([0x00, 0x04, 0, 0, 1])],
    ['an invalid y', new Uint8Array([0, 0, 0x00, 0x04, 1])],
    ['the untouched colour', new Uint8Array([0, 0, 0, 0, 0])],
    ['a colour above the palette', new Uint8Array([0, 0, 0, 0, 17])],
  ])('rejects %s', (_label, bytes) => {
    expect(() => decodeDelta(bytes)).toThrow();
  });

  it('rejects duplicate coordinates', () => {
    const duplicateBoth = new Uint8Array([1, 0, 2, 0, 1, 1, 0, 2, 0, 2]);
    expect(() => decodeDelta(duplicateBoth)).toThrow(/Duplicate/);
  });
});

describe('delta validation', () => {
  it('rejects an empty delta', () => {
    expect(() => encodeDelta([])).toThrow(RangeError);
    expect(() => decodeDelta(new Uint8Array())).toThrow(RangeError);
  });

  it('rejects byte lengths that are not a multiple of five', () => {
    for (const length of [1, 4, 6, 9]) {
      expect(() => decodeDelta(new Uint8Array(length))).toThrow(/multiple of 5/);
    }
  });

  it('applies the maximum pixel count on encode and decode', () => {
    const pixels = [pixel(0, 0, 1), pixel(1, 0, 2), pixel(2, 0, 3)];
    expect(() => encodeDelta(pixels, 2)).toThrow(RangeError);
    expect(() => decodeDelta(encodeDelta(pixels), 2)).toThrow(RangeError);
    expect(() => encodeDelta(pixels, 3)).not.toThrow();
  });

  it('uses the 500-pixel default cap', () => {
    const pixels = Array.from({ length: 501 }, (_, i) => pixel(i, 0, 1));
    expect(() => encodeDelta(pixels)).toThrow(RangeError);
    expect(() => encodeDelta(pixels, 501)).not.toThrow();
  });

  it('rejects invalid coordinates on encode', () => {
    expect(() => encodeDelta([pixel(-1, 0, 1)])).toThrow(RangeError);
    expect(() => encodeDelta([pixel(0, 1_024, 1)])).toThrow(RangeError);
  });

  it('rejects duplicates on encode', () => {
    expect(() => encodeDelta([pixel(1, 2, 1), pixel(1, 2, 2)])).toThrow(/Duplicate/);
  });

  it('requires a positive maximum', () => {
    expect(() => encodeDelta([pixel(0, 0, 1)], 0)).toThrow(RangeError);
    expect(() => decodeDelta(encodeDelta([pixel(0, 0, 1)]), 0)).toThrow(RangeError);
  });
});
