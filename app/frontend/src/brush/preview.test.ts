import { TILE_PIXELS } from '@pixelwar/shared/grid';
import { describe, expect, it, vi } from 'vitest';
import { PreviewLayer } from './preview';

function setup() {
  const timers: Array<() => void> = [];
  const preview = new PreviewLayer({ setTimer: (callback) => timers.push(callback) });
  const changes = vi.fn();
  preview.subscribe(changes);
  const canvas = new Uint8Array(TILE_PIXELS);
  const source = { get: (tx: number, ty: number) => (tx === 0 && ty === 0 ? canvas : null) };
  return { preview, changes, timers, canvas, source };
}

describe('PreviewLayer', () => {
  it('shows the pixels just sent on their tiles, negative ones included', () => {
    const { preview, changes } = setup();
    preview.add([{ x: 1, y: 0, color: 4 }, { x: -1, y: -1, color: 6 }]);
    expect(preview.get(0, 0)?.[1]).toBe(4);
    expect(preview.get(-1, -1)?.[TILE_PIXELS - 1]).toBe(6);
    expect(preview.size).toBe(2);
    expect(preview.keys()).toEqual([{ tx: 0, ty: 0 }, { tx: -1, ty: -1 }]);
    expect(changes).toHaveBeenCalledWith([{ tx: 0, ty: 0 }, { tx: -1, ty: -1 }]);
  });

  it('drops a pixel once the canvas shows its colour, and keeps the others', () => {
    const { preview, changes, canvas, source } = setup();
    preview.add([{ x: 1, y: 0, color: 4 }, { x: 2, y: 0, color: 4 }]);
    canvas[1] = 4;
    canvas[2] = 9;
    preview.settle([{ tx: 0, ty: 0 }], source);
    expect(preview.get(0, 0)?.[1]).toBe(0);
    expect(preview.get(0, 0)?.[2]).toBe(4);
    expect(changes).toHaveBeenLastCalledWith([{ tx: 0, ty: 0 }]);
    canvas[2] = 4;
    preview.settle([{ tx: 0, ty: 0 }], source);
    expect(preview.get(0, 0)).toBeNull();
    expect(preview.size).toBe(0);
  });

  it('forgets what never arrived after its delay, but not a newer colour', () => {
    const { preview, timers } = setup();
    preview.add([{ x: 1, y: 0, color: 4 }, { x: 2, y: 0, color: 4 }]);
    preview.add([{ x: 2, y: 0, color: 7 }]);
    timers[0]!();
    expect(preview.get(0, 0)?.[1]).toBe(0);
    expect(preview.get(0, 0)?.[2]).toBe(7);
    timers[1]!();
    expect(preview.size).toBe(0);
  });

  it('keeps a pixel 5 s at most by default', () => {
    const delays: number[] = [];
    const preview = new PreviewLayer({ setTimer: (_callback, ms) => delays.push(ms) });
    preview.add([{ x: 1, y: 0, color: 4 }]);
    expect(delays).toEqual([5_000]);
  });

  it('is cleared by a new canvas version', () => {
    const { preview, changes, timers, source } = setup();
    preview.add([{ x: 1, y: 0, color: 4 }]);
    preview.settle('all', source);
    expect(preview.size).toBe(0);
    expect(changes).toHaveBeenLastCalledWith('all');
    timers[0]!();
    expect(changes).toHaveBeenCalledTimes(2);
  });
});
