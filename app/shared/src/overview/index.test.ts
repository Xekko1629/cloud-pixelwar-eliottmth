import { describe, expect, it } from 'vitest';
import {
  assertOverviewCell, isOverviewLevel, overviewArea, overviewObjectName, overviewParent, overviewScale, overviewSpan,
  overviewVersionPrefix,
} from '.';

describe('overview pyramid geometry (ADR-0007)', () => {
  it('covers 1, 4×4 and 16×16 regions with 256-pixel images', () => {
    expect([1, 2, 3].map((l) => [overviewScale(l as 1), overviewSpan(l as 1)])).toEqual([[4, 1024], [16, 4096], [64, 16384]]);
    expect(overviewArea(2, -1, 0)).toEqual({ min_x: -4096, min_y: 0, max_x: -1, max_y: 4095 });
  });
  it('finds the parent cell of a region, negative coordinates included', () => {
    expect(overviewParent(1, -1, 5)).toEqual({ cx: -1, cy: 5 });
    expect(overviewParent(2, -1, 5)).toEqual({ cx: -1, cy: 1 });
    expect(overviewParent(3, 15, -17)).toEqual({ cx: 0, cy: -2 });
  });
  it('names objects by version, level and cell', () => {
    expect(overviewObjectName(3, 1, -2, 7)).toBe('v3/1/-2_7.png');
    expect(overviewVersionPrefix(3)).toBe('v3/');
    expect(() => overviewObjectName(0, 1, 0, 0)).toThrow();
  });
  it('refuses levels and cells outside the grid', () => {
    expect([0, 1, 2, 3, 4, '1'].map(isOverviewLevel)).toEqual([false, true, true, true, false, false]);
    expect(() => assertOverviewCell(4 as 1, 0, 0)).toThrow('level');
    expect(() => assertOverviewCell(1, 1_000_000, 0)).toThrow('cx');
    expect(() => assertOverviewCell(3, 0, 0.5)).toThrow('cy');
    expect(() => assertOverviewCell(3, 61_035, -61_036)).not.toThrow();
  });
});
