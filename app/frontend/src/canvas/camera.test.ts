import { COORDINATE_LIMIT } from '@pixelwar/shared/grid';
import { describe, expect, it } from 'vitest';
import {
  MAX_ZOOM,
  MIN_ZOOM,
  clampCamera,
  initialCamera,
  pan,
  pixelAt,
  screenToWorld,
  visiblePixels,
  visibleTiles,
  worldToScreen,
  zoomAt,
} from './camera';

const viewport = { width: 800, height: 600 };
const FAR = COORDINATE_LIMIT - 100;

describe('camera', () => {
  it('opens on the origin', () => {
    const camera = initialCamera();
    expect([camera.x, camera.y]).toEqual([0, 0]);
    expect(pixelAt(camera, viewport, { x: 400, y: 300 })).toEqual({ x: 0, y: 0 });
    expect(pixelAt(camera, viewport, { x: 399, y: 299 })).toEqual({ x: -1, y: -1 });
  });

  it('converts between screen and world both ways', () => {
    const camera = { x: 12.25, y: -40.5, zoom: 3 };
    const screen = { x: 123, y: 456 };
    expect(worldToScreen(camera, viewport, screenToWorld(camera, viewport, screen))).toEqual(screen);
  });

  it('pans with the pointer', () => {
    const moved = pan({ x: 0, y: 0, zoom: 4 }, 40, -20);
    expect([moved.x, moved.y]).toEqual([-10, 5]);
  });

  it('zooms around the anchor, which stays on the same world point', () => {
    const camera = { x: 100, y: 200, zoom: 2 };
    const anchor = { x: 650, y: 120 };
    const before = screenToWorld(camera, viewport, anchor);

    const zoomed = zoomAt(camera, viewport, 3, anchor);

    expect(zoomed.zoom).toBe(6);
    const after = screenToWorld(zoomed, viewport, anchor);
    expect(after.x).toBeCloseTo(before.x, 9);
    expect(after.y).toBeCloseTo(before.y, 9);
  });

  it('bounds the zoom and the position', () => {
    expect(zoomAt(initialCamera(), viewport, 1e6, { x: 0, y: 0 }).zoom).toBe(MAX_ZOOM);
    expect(zoomAt(initialCamera(), viewport, 1e-6, { x: 0, y: 0 }).zoom).toBe(MIN_ZOOM);
    expect(clampCamera({ x: 5e9, y: -5e9, zoom: 4 })).toEqual({ x: COORDINATE_LIMIT + 1, y: -COORDINATE_LIMIT, zoom: 4 });
    expect(pixelAt({ x: COORDINATE_LIMIT + 1, y: 0, zoom: 1 }, viewport, { x: 799, y: 300 })).toBeNull();
  });

  it('lists the visible pixels and tiles, including partly visible ones', () => {
    const camera = { x: 0.5, y: 0.5, zoom: 10 };
    // 800 / 10 = 80 pixels wide: from -39.5 to 40.5.
    expect(visiblePixels(camera, viewport)).toEqual({ min_x: -40, min_y: -30, max_x: 40, max_y: 30 });
    expect(visibleTiles(camera, viewport)).toEqual({ min_x: -1, min_y: -1, max_x: 0, max_y: 0 });
  });

  it('clips the visible pixels to the validated coordinates', () => {
    const pixels = visiblePixels({ x: COORDINATE_LIMIT, y: -COORDINATE_LIMIT, zoom: 1 }, viewport);
    expect(pixels.max_x).toBe(COORDINATE_LIMIT);
    expect(pixels.min_y).toBe(-COORDINATE_LIMIT);
  });
});

describe('camera far from the origin', () => {
  it('keeps sub-pixel precision near 10⁹', () => {
    const camera = { x: FAR + 0.25, y: FAR + 0.75, zoom: 64 };
    expect(worldToScreen(camera, viewport, { x: FAR, y: FAR })).toEqual({ x: 384, y: 252 });
    expect(pixelAt(camera, viewport, { x: 384, y: 252 })).toEqual({ x: FAR, y: FAR });
    expect(pixelAt(camera, viewport, { x: 383.9, y: 251.9 })).toEqual({ x: FAR - 1, y: FAR - 1 });
  });

  it('moves by one grid pixel exactly', () => {
    const camera = pan({ x: FAR, y: FAR, zoom: 64 }, -64, -64);
    expect([camera.x, camera.y]).toEqual([FAR + 1, FAR + 1]);
  });

  it('gives the same picture around 10⁹ as around the origin', () => {
    const near = { x: 3.5, y: 7.25, zoom: 7 };
    const far = { ...near, x: near.x + FAR, y: near.y - FAR };
    const offsets = [0, 1, 17, 64, 100];
    for (const offset of offsets) {
      const a = worldToScreen(near, viewport, { x: offset, y: offset });
      const b = worldToScreen(far, viewport, { x: offset + FAR, y: offset - FAR });
      expect(b).toEqual(a);
    }
  });

  it('a float32 position would be off by tens of pixels there', () => {
    // What the camera-relative arithmetic avoids: Math.fround is the float32 of WebGL.
    expect(Math.abs(Math.fround(FAR + 17) - (FAR + 17))).toBeGreaterThan(10);
  });
});
