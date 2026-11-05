import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_BATCH_PIXELS,
  DELTA_ENCODING_VERSION,
  DELTA_PIXEL_BYTES,
  MAX_REGIONS_PER_QUERY,
  PALETTE,
  TILE_PIXELS,
  TILE_SIDE,
  assertCanvasVersion,
  assertColor,
  assertInteger,
} from './constants';

describe('grid constants', () => {
  it('uses 64x64 tiles', () => {
    expect(TILE_SIDE).toBe(64);
    expect(TILE_PIXELS).toBe(4_096);
    expect(DELTA_PIXEL_BYTES).toBe(5);
  });

  it('starts with the validated 500-pixel batch cap', () => {
    expect(DEFAULT_MAX_BATCH_PIXELS).toBe(500);
  });

  it('keeps the delta ABI and Firestore in-query limit explicit', () => {
    expect(DELTA_ENCODING_VERSION).toBe(1);
    expect(MAX_REGIONS_PER_QUERY).toBe(30);
  });

  it('defines 16 distinct colour codes', () => {
    expect(PALETTE).toHaveLength(16);
    expect(new Set(PALETTE).size).toBe(16);
    for (const colour of PALETTE) expect(colour).toMatch(/^#[0-9A-F]{6}$/);
  });

  it('keeps index 0 out of the drawable palette', () => {
    expect(PALETTE).not.toContain(0);
    expect(() => assertColor(0)).toThrow(RangeError);
    expect(() => assertColor(0, true)).not.toThrow();
  });
});

describe('assertInteger', () => {
  it('accepts bounded safe integers', () => {
    expect(() => assertInteger(0, 0, 10, 'value')).not.toThrow();
    expect(() => assertInteger(10, 0, 10, 'value')).not.toThrow();
    expect(() => assertInteger(-10, -10, 10, 'value')).not.toThrow();
  });

  it.each([
    ['below the minimum', -1],
    ['above the maximum', 11],
    ['a float', 1.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['an unsafe integer', Number.MAX_SAFE_INTEGER + 1],
  ])('rejects %s', (_label, value) => {
    expect(() => assertInteger(value, 0, 10, 'value')).toThrow(RangeError);
  });
});

describe('assertColor', () => {
  it('accepts drawn palette indexes 1 to 16', () => {
    for (let colour = 1; colour <= 16; colour++) {
      expect(() => assertColor(colour)).not.toThrow();
    }
  });

  it('accepts the untouched index only when explicitly allowed', () => {
    expect(() => assertColor(0, true)).not.toThrow();
    expect(() => assertColor(0)).toThrow(/color/);
  });

  it.each([17, -1, 1.5])('rejects %s', (colour) => {
    expect(() => assertColor(colour, true)).toThrow(RangeError);
  });
});

describe('assertCanvasVersion', () => {
  it('accepts positive versions', () => {
    expect(() => assertCanvasVersion(1)).not.toThrow();
    expect(() => assertCanvasVersion(Number.MAX_SAFE_INTEGER)).not.toThrow();
  });

  it.each([0, -1, 1.5])('rejects %s', (version) => {
    expect(() => assertCanvasVersion(version)).toThrow(RangeError);
  });
});
