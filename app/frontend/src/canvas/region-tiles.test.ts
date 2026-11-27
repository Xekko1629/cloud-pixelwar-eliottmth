import { TILE_PIXELS } from '@pixelwar/shared/grid';
import { describe, expect, it, vi } from 'vitest';
import type { DecodedRegionTiles } from '@pixelwar/shared/grid';
import { RegionTileStore, regionOfTile, type RegionFetcher } from './region-tiles';

// A fetcher whose answers the test releases one by one.
function deferredFetcher() {
  const calls: Array<{ rx: number; ry: number; resolve: (answer: DecodedRegionTiles) => void; reject: (error: Error) => void }> = [];
  const fetcher: RegionFetcher = (rx, ry) => new Promise((resolve, reject) => calls.push({ rx, ry, resolve, reject }));
  return { fetcher, calls };
}

const colors = (color: number) => new Uint8Array(TILE_PIXELS).fill(color);
const loaded = (tiles: DecodedRegionTiles['tiles']): DecodedRegionTiles => ({ canvas_version: 1, tiles });
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
// One region at the origin, and one region left of it (negative coordinates).
const ORIGIN = { min_x: 0, min_y: 0, max_x: 100, max_y: 100 };
const LEFT = { min_x: -100, min_y: 0, max_x: -1, max_y: 100 };

describe('regionOfTile', () => {
  it('rounds down, negative tiles included', () => {
    expect(regionOfTile(0, 15)).toEqual({ rx: 0, ry: 0 });
    expect(regionOfTile(16, -1)).toEqual({ rx: 1, ry: -1 });
    expect(regionOfTile(-16, -17)).toEqual({ rx: -1, ry: -2 });
  });
});

describe('RegionTileStore', () => {
  it('requests nothing while signed out', () => {
    const status = vi.fn();
    const store = new RegionTileStore({ status });
    store.show(ORIGIN);
    expect(store.size).toBe(0);
    expect(status).toHaveBeenLastCalledWith('signed-out');
  });

  it('loads nothing in the far view, whatever the number of regions', () => {
    const { fetcher, calls } = deferredFetcher();
    const status = vi.fn();
    const store = new RegionTileStore({ status });
    store.setFetcher(fetcher);
    store.show(LEFT, true);
    expect(calls).toHaveLength(0);
    expect(status).toHaveBeenLastCalledWith('far');
  });

  it('loads each visible region once and serves its tiles', async () => {
    const { fetcher, calls } = deferredFetcher();
    const events = { loading: vi.fn(), loaded: vi.fn(), status: vi.fn() };
    const store = new RegionTileStore(events);
    store.setFetcher(fetcher);
    store.show(LEFT);
    store.show(LEFT);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ rx: -1, ry: 0 });
    expect(events.status).toHaveBeenLastCalledWith('loading');

    calls[0]!.resolve(loaded([{ tx: -1, ty: 0, colors: colors(3) }]));
    await flush();
    expect(events.loaded).toHaveBeenCalledWith({ rx: -1, ry: 0 });
    expect(events.status).toHaveBeenLastCalledWith('ready');
    expect(store.get(-1, 0)?.[0]).toBe(3);
    expect(store.get(-2, 0)).toBeNull();
    store.show(LEFT);
    expect(calls).toHaveLength(1);
  });

  it('releases the least recently shown regions that left the view, past its capacity', async () => {
    const { fetcher, calls } = deferredFetcher();
    const store = new RegionTileStore({}, { capacity: 1 });
    store.setFetcher(fetcher);
    store.show(ORIGIN);
    calls[0]!.resolve(loaded([{ tx: 0, ty: 0, colors: colors(2) }]));
    await flush();
    store.show(LEFT);
    expect(store.size).toBe(1);
    expect(store.get(0, 0)).toBeNull();
    store.show(ORIGIN);
    expect(calls.at(-1)).toMatchObject({ rx: 0, ry: 0 });
  });

  it('keeps every visible region, even above its capacity', () => {
    const { fetcher, calls } = deferredFetcher();
    const store = new RegionTileStore({}, { capacity: 1 });
    store.setFetcher(fetcher);
    store.show({ min_x: -100, min_y: 0, max_x: 100, max_y: 100 });
    expect(calls).toHaveLength(2);
    expect(store.size).toBe(2);
  });

  it('loads nothing in the far view', () => {
    const { fetcher, calls } = deferredFetcher();
    const status = vi.fn();
    const store = new RegionTileStore({ status });
    store.setFetcher(fetcher);
    store.show({ min_x: 0, min_y: 0, max_x: 10 * 1024, max_y: 10 * 1024 });
    expect(calls).toHaveLength(0);
    expect(status).toHaveBeenLastCalledWith('far');
  });

  it('retries a failed region after the delay, if it is still visible', async () => {
    const { fetcher, calls } = deferredFetcher();
    const timers: Array<() => void> = [];
    let now = 0;
    const events = { abandoned: vi.fn(), status: vi.fn() };
    const store = new RegionTileStore(events, {
      now: () => now, retryAfterMs: 10_000, setTimer: (callback) => timers.push(callback),
    });
    store.setFetcher(fetcher);
    store.show(ORIGIN);
    calls[0]!.reject(new Error('503'));
    await flush();
    expect(events.abandoned).toHaveBeenCalledWith({ rx: 0, ry: 0 });
    expect(events.status).toHaveBeenLastCalledWith('error');
    store.show(ORIGIN);
    expect(calls).toHaveLength(1);
    now = 10_000;
    timers[0]!();
    expect(calls).toHaveLength(2);
  });

  it('asks again for the visible regions, and keeps the tiles until the answer', async () => {
    const { fetcher, calls } = deferredFetcher();
    const store = new RegionTileStore();
    store.setFetcher(fetcher);
    store.show(ORIGIN);
    store.revalidate();
    expect(calls).toHaveLength(1);
    calls[0]!.resolve(loaded([{ tx: 0, ty: 0, colors: colors(5) }]));
    await flush();
    store.revalidate();
    expect(calls).toHaveLength(2);
    expect(store.get(0, 0)?.[0]).toBe(5);
    calls[1]!.resolve(loaded([{ tx: 0, ty: 0, colors: colors(6) }]));
    await flush();
    expect(store.get(0, 0)?.[0]).toBe(6);
    // A failed revalidation keeps the tiles, and is not an error.
    const status = vi.fn();
    const watched = new RegionTileStore({ status });
    watched.setFetcher(fetcher);
    watched.show(ORIGIN);
    calls[2]!.resolve(loaded([{ tx: 0, ty: 0, colors: colors(7) }]));
    await flush();
    watched.revalidate();
    calls[3]!.reject(new Error('offline'));
    await flush();
    expect(watched.get(0, 0)?.[0]).toBe(7);
    expect(status).toHaveBeenLastCalledWith('ready');
  });

  it('drops every region on sign-out and ignores the answers still in flight', async () => {
    const { fetcher, calls } = deferredFetcher();
    const events = { cleared: vi.fn(), loaded: vi.fn(), abandoned: vi.fn(), status: vi.fn() };
    const store = new RegionTileStore(events);
    store.setFetcher(fetcher);
    store.show(ORIGIN);
    store.setFetcher(fetcher);
    expect(calls).toHaveLength(1);
    store.setFetcher(null);
    expect(events.cleared).toHaveBeenCalledTimes(1);
    expect(events.abandoned).toHaveBeenCalledWith({ rx: 0, ry: 0 });
    expect(events.status).toHaveBeenLastCalledWith('signed-out');
    calls[0]!.resolve(loaded([{ tx: 0, ty: 0, colors: colors(1) }]));
    await flush();
    expect(events.loaded).not.toHaveBeenCalled();
    expect(store.get(0, 0)).toBeNull();
  });

  it('loads the visible regions again for a new canvas version', async () => {
    const { fetcher, calls } = deferredFetcher();
    const store = new RegionTileStore();
    store.setFetcher(fetcher);
    store.show(ORIGIN);
    calls[0]!.resolve(loaded([{ tx: 0, ty: 0, colors: colors(1) }]));
    await flush();
    store.clear();
    expect(store.get(0, 0)).toBeNull();
    expect(calls).toHaveLength(2);
  });

  it('requires a positive capacity', () => {
    expect(() => new RegionTileStore({}, { capacity: 0 })).toThrow(RangeError);
  });
});
