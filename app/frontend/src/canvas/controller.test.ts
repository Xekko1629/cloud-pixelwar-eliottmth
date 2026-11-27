import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_ZOOM, screenToWorld, type Camera } from './camera';
import { CanvasController } from './controller';

const viewport = { width: 800, height: 600 };

function controller(camera?: Camera) {
  const onChange = vi.fn();
  return { onChange, controller: new CanvasController(() => viewport, onChange, camera) };
}

describe('CanvasController', () => {
  it('pans while one pointer is dragged', () => {
    const { controller: c, onChange } = controller();

    c.pointerDown(1, { x: 100, y: 100 });
    expect(c.dragging).toBe(true);
    c.pointerMove(1, { x: 140, y: 80 });
    c.pointerUp(1);
    c.pointerMove(1, { x: 500, y: 500 });

    expect(c.current).toEqual({ x: -10, y: 5, zoom: DEFAULT_ZOOM });
    expect(c.dragging).toBe(false);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('ignores moves of a pointer that is not pressed', () => {
    const { controller: c, onChange } = controller();
    c.pointerMove(7, { x: 10, y: 10 });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('zooms around the cursor with the wheel', () => {
    const { controller: c } = controller();
    const anchor = { x: 600, y: 150 };
    const before = screenToWorld(c.current, viewport, anchor);

    c.wheel(-100, 0, anchor);

    expect(c.current.zoom).toBeCloseTo(DEFAULT_ZOOM * Math.exp(0.15), 9);
    const after = screenToWorld(c.current, viewport, anchor);
    expect(after.x).toBeCloseTo(before.x, 9);
    expect(after.y).toBeCloseTo(before.y, 9);
  });

  it('scales line and page wheel deltas', () => {
    const lines = controller().controller;
    const pages = controller().controller;
    const pixels = controller().controller;
    lines.wheel(3, 1, { x: 400, y: 300 });
    pixels.wheel(48, 0, { x: 400, y: 300 });
    pages.wheel(1, 2, { x: 400, y: 300 });
    expect(lines.current.zoom).toBeCloseTo(pixels.current.zoom, 12);
    expect(pages.current.zoom).toBeCloseTo(DEFAULT_ZOOM * Math.exp(-600 * 0.0015), 9);
  });

  it('pinches: spreading two fingers zooms around their centre', () => {
    const { controller: c } = controller();
    c.pointerDown(1, { x: 300, y: 300 });
    c.pointerDown(2, { x: 500, y: 300 });
    const centre = screenToWorld(c.current, viewport, { x: 400, y: 300 });

    c.pointerMove(2, { x: 700, y: 300 }); // distance 200 → 400, centre (400, 300) → (500, 300)

    expect(c.current.zoom).toBeCloseTo(DEFAULT_ZOOM * 2, 9);
    const after = screenToWorld(c.current, viewport, { x: 500, y: 300 });
    expect(after.x).toBeCloseTo(centre.x, 9);
    expect(after.y).toBeCloseTo(centre.y, 9);
  });

  it('ignores a third finger and a pinch with coincident fingers', () => {
    const { controller: c } = controller();
    c.pointerDown(1, { x: 300, y: 300 });
    c.pointerDown(2, { x: 300, y: 300 });
    c.pointerDown(3, { x: 0, y: 0 });
    c.pointerMove(3, { x: 50, y: 50 });
    expect(c.current).toEqual({ x: 0, y: 0, zoom: DEFAULT_ZOOM });

    c.pointerMove(2, { x: 310, y: 300 });
    expect(c.current.zoom).toBe(DEFAULT_ZOOM);
  });

  it('moves with the keyboard and returns to the origin', () => {
    const { controller: c } = controller({ x: 50, y: 50, zoom: 4 });

    expect(c.key('ArrowRight')).toBe(true);
    expect(c.key('ArrowDown')).toBe(true);
    expect(c.current).toMatchObject({ x: 66, y: 66 });
    c.key('ArrowLeft');
    c.key('ArrowUp');
    expect(c.current).toMatchObject({ x: 50, y: 50 });
    c.key('+');
    expect(c.current.zoom).toBe(5);
    c.key('=');
    c.key('-');
    expect(c.current.zoom).toBeCloseTo(5, 12);
    c.key('0');
    expect(c.current).toEqual({ x: 0, y: 0, zoom: DEFAULT_ZOOM });
    expect(c.key('a')).toBe(false);
  });

  it('notifies only real camera changes', () => {
    const { controller: c, onChange } = controller();
    c.moveTo({ x: 0, y: 0, zoom: DEFAULT_ZOOM });
    expect(onChange).not.toHaveBeenCalled();
    c.moveTo({ x: 9, y: 9, zoom: 2 });
    expect(onChange).toHaveBeenCalledWith({ x: 9, y: 9, zoom: 2 });
  });

  describe('taps', () => {
    it('reports a press that barely moved as a tap, where it started', () => {
      const c = new CanvasController(() => viewport, () => {});
      c.pointerDown(1, { x: 10, y: 10 });
      c.pointerMove(1, { x: 13, y: 12 });
      expect(c.pointerUp(1)).toEqual({ x: 10, y: 10 });
    });

    it('is not a tap after a drag, a second finger or a cancel', () => {
      const c = new CanvasController(() => viewport, () => {});
      c.pointerDown(1, { x: 10, y: 10 });
      c.pointerMove(1, { x: 40, y: 10 });
      expect(c.pointerUp(1)).toBeNull();

      c.pointerDown(1, { x: 10, y: 10 });
      c.pointerDown(2, { x: 50, y: 50 });
      expect(c.pointerUp(2)).toBeNull();
      expect(c.pointerUp(1)).toBeNull();

      c.pointerDown(3, { x: 10, y: 10 });
      c.pointerCancel(3);
      expect(c.pointerUp(3)).toBeNull();
      expect(c.dragging).toBe(false);
    });
  });
});
