import { describe, expect, it, vi } from 'vitest';
import { IMAGE_LAG_MS, OverviewImages, RecentPixels, cellArea, overviewLevel, visibleCells } from './overview';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const picture = (id: string) => ({ id }) as unknown as CanvasImageSource;

describe('far view geometry', () => {
  it('picks the coarsest level whose image pixel still covers one CSS pixel', () => {
    expect(overviewLevel(0.5)).toBe(1);
    expect(overviewLevel(1 / 4)).toBe(1);
    expect(overviewLevel(0.2)).toBe(2);
    expect(overviewLevel(1 / 16)).toBe(2);
    expect(overviewLevel(1 / 64)).toBe(3);
  });

  it('lists the visible cells of a level, negative ones included', () => {
    // 800×600 at zoom 1/4 around the origin: 3200×2400 grid pixels, level 1 cells of 1024.
    expect(visibleCells({ x: 0, y: 0, zoom: 1 / 4 }, { width: 800, height: 600 }, 1))
      .toEqual({ min_x: -2, min_y: -2, max_x: 1, max_y: 1 });
    expect(cellArea(2, -1, 0)).toEqual({ min_x: -4096, min_y: 0, max_x: -1, max_y: 4095 });
  });
});

describe('OverviewImages', () => {
  function setup() {
    let now = 0;
    const answers: Array<{ level: number; cx: number; cy: number; resolve: (image: CanvasImageSource | null) => void; reject: () => void }> = [];
    const load = vi.fn((level: number, cx: number, cy: number) =>
      new Promise<CanvasImageSource | null>((resolve, reject) => answers.push({ level, cx, cy, resolve, reject: () => reject(new Error('x')) })));
    const images = new OverviewImages(load, { now: () => now, capacity: 4 });
    const loaded = vi.fn();
    images.subscribe(loaded);
    return { images, load, answers, loaded, advance: (ms: number) => { now += ms; } };
  }

  it('loads each visible cell once, and reports the area of a loaded image', async () => {
    const { images, load, answers, loaded } = setup();
    images.show(1, { min_x: 0, min_y: 0, max_x: 1, max_y: 0 });
    images.show(1, { min_x: 0, min_y: 0, max_x: 1, max_y: 0 });
    expect(load).toHaveBeenCalledTimes(2);
    answers[0]!.resolve(picture('a'));
    answers[1]!.resolve(null);
    await flush();
    expect(images.get(1, 0, 0)).toEqual(picture('a'));
    expect(images.get(1, 1, 0)).toBeNull();
    expect(loaded).toHaveBeenCalledWith(cellArea(1, 0, 0), 0);
  });

  it('asks a shown image again once stale, keeping the old one meanwhile', async () => {
    const { images, load, answers, advance } = setup();
    images.show(3, { min_x: 0, min_y: 0, max_x: 0, max_y: 0 });
    answers[0]!.resolve(picture('old'));
    await flush();
    advance(60_000);
    images.show(3, { min_x: 0, min_y: 0, max_x: 0, max_y: 0 });
    expect(load).toHaveBeenCalledTimes(1);
    advance(60_001);
    images.show(3, { min_x: 0, min_y: 0, max_x: 0, max_y: 0 });
    expect(load).toHaveBeenCalledTimes(2);
    expect(images.get(3, 0, 0)).toEqual(picture('old'));
    answers[1]!.resolve(picture('new'));
    await flush();
    expect(images.get(3, 0, 0)).toEqual(picture('new'));
  });

  it('retries a failure after a delay, and keeps at most its capacity', async () => {
    const { images, load, answers, advance } = setup();
    images.show(1, { min_x: 0, min_y: 0, max_x: 0, max_y: 0 });
    answers[0]!.reject();
    await flush();
    images.show(1, { min_x: 0, min_y: 0, max_x: 0, max_y: 0 });
    expect(load).toHaveBeenCalledTimes(1);
    advance(10_000);
    images.show(1, { min_x: 0, min_y: 0, max_x: 0, max_y: 0 });
    expect(load).toHaveBeenCalledTimes(2);
    images.show(1, { min_x: 1, min_y: 0, max_x: 5, max_y: 0 });
    expect(images.size).toBe(4);
  });

  it('drops the answers of a previous canvas version', async () => {
    const { images, answers, loaded } = setup();
    images.show(1, { min_x: 0, min_y: 0, max_x: 0, max_y: 0 });
    images.clear();
    answers[0]!.resolve(picture('old version'));
    await flush();
    expect(images.get(1, 0, 0)).toBeNull();
    expect(loaded).not.toHaveBeenCalled();
  });
});

describe('RecentPixels', () => {
  it('keeps the last colour of each pixel and lists those in view', () => {
    const recent = new RecentPixels();
    recent.add([{ x: 1, y: 1, color: 3 }, { x: 5000, y: 0, color: 4 }], 0);
    recent.add([{ x: 1, y: 1, color: 7 }], 10);
    expect([...recent.inside({ min_x: 0, min_y: 0, max_x: 100, max_y: 100 })]).toEqual([{ x: 1, y: 1, color: 7, at: 10 }]);
  });

  it('forgets the pixels an image asked long enough after them already shows', () => {
    const recent = new RecentPixels();
    recent.add([{ x: 1, y: 1, color: 3 }], 0);
    recent.add([{ x: 2, y: 2, color: 3 }], 60_000);
    recent.covered(cellArea(1, 0, 0), IMAGE_LAG_MS);
    expect([...recent.inside(cellArea(1, 0, 0))].map((p) => p.x)).toEqual([2]);
    // Outside the image: kept.
    recent.add([{ x: -5, y: 1, color: 3 }], 0);
    recent.covered(cellArea(1, 0, 0), 10 * IMAGE_LAG_MS);
    expect(recent.size).toBe(1);
  });

  it('keeps at most its capacity, the oldest going first', () => {
    const recent = new RecentPixels(2);
    recent.add([{ x: 1, y: 0, color: 1 }, { x: 2, y: 0, color: 1 }, { x: 3, y: 0, color: 1 }], 0);
    expect([...recent.inside({ min_x: 0, min_y: 0, max_x: 9, max_y: 9 })].map((p) => p.x)).toEqual([2, 3]);
    recent.clear();
    expect(recent.size).toBe(0);
  });
});
