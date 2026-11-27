import { encodeDelta } from '@pixelwar/shared/grid';
import { describe, expect, it, vi } from 'vitest';
import type { DecodedRegionTiles } from '@pixelwar/shared/grid';
import type { RegionFetcher } from '../canvas/region-tiles';
import type { FirestoreBackend } from './feed';
import { LiveCanvas } from './live';

function backend() {
  const state = {
    config: (_data: unknown, _fromCache?: boolean) => {},
    deltas: [] as Array<(docs: unknown[]) => void>,
  };
  const fake: FirestoreBackend = {
    watchConfig(next) {
      state.config = next;
      return () => {};
    },
    watchDeltas(_query, added) {
      state.deltas.push(added);
      return () => {};
    },
  };
  return { fake, state };
}

const delta = (x: number, y: number, color: number, at = 1) => ({
  encoding_version: 1, canvas_version: 1, region: '0_0', event_id: 'e',
  created_at: { toMillis: () => at }, pixels: encodeDelta([{ x, y, color }]),
});

describe('LiveCanvas', () => {
  it('is disabled without a Firestore configuration', async () => {
    const live = new LiveCanvas(null);
    await live.start();
    expect(live.getState()).toEqual({ status: 'disabled', config: null, tiles: 'signed-out' });
  });

  it('reports a SDK that cannot be loaded', async () => {
    const live = new LiveCanvas(() => Promise.reject(new Error('offline')));
    await live.start();
    expect(live.getState().status).toBe('error');
  });

  it('follows the viewport given before the SDK loaded, and repaints the touched tiles', async () => {
    const { fake, state } = backend();
    const live = new LiveCanvas(async () => fake, {
      setTimer: (callback) => {
        callback();
        return 0;
      },
    });
    const changes = vi.fn();
    const stateListener = vi.fn();
    live.subscribe(changes);
    live.subscribeState(stateListener);
    live.viewportChanged({ min_x: 0, min_y: 0, max_x: 100, max_y: 100 });
    await live.start();
    await live.start();
    state.config({ canvas_version: 1, paused: true });
    expect(live.getState()).toEqual({
      status: 'live', config: { paused: true, canvasVersion: 1, size: null, bounds: null }, tiles: 'signed-out',
    });
    expect(stateListener).toHaveBeenCalled();
    expect(state.deltas).toHaveLength(1);
    state.deltas[0]!([delta(70, 2, 4)]);
    expect(changes).toHaveBeenCalledWith([{ tx: 1, ty: 0 }]);
    expect(live.source.get(1, 0)![2 * 64 + 6]).toBe(4);
    live.viewportChanged({ min_x: 0, min_y: 0, max_x: 2000, max_y: 100 });
    expect(state.deltas).toHaveLength(2);
    state.config({ canvas_version: 2 });
    expect(changes).toHaveBeenLastCalledWith('all');
    expect(live.source.get(1, 0)).toBeNull();
    live.stop();
  });

  describe('with the tiles of tile-reader', () => {
    const immediate = { setTimer: (callback: () => void) => { callback(); return 0; } };
    const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
    const tile = (color: number) => new Uint8Array(64 * 64).fill(color);

    async function signedIn() {
      const { fake, state } = backend();
      const answers: Array<(answer: DecodedRegionTiles) => void> = [];
      const fetcher = vi.fn<RegionFetcher>(() => new Promise((resolve) => answers.push(resolve)));
      const live = new LiveCanvas(async () => fake, immediate);
      const changes = vi.fn();
      live.subscribe(changes);
      live.setTileFetcher(fetcher);
      live.viewportChanged({ min_x: 0, min_y: 0, max_x: 100, max_y: 100 });
      await live.start();
      state.config({ canvas_version: 1 });
      return { live, state, answers, fetcher, changes };
    }

    it('paints again over the loaded tiles the pixels received during the request', async () => {
      const { live, state, answers, changes } = await signedIn();
      expect(live.getState().tiles).toBe('loading');
      state.deltas[0]!([delta(1, 0, 9)]);
      // The answer was read before that pixel: it still has colour 2 there.
      answers[0]!({ canvas_version: 1, tiles: [{ tx: 0, ty: 0, colors: tile(2) }] });
      await flush();
      expect(live.getState().tiles).toBe('ready');
      expect(live.source.get(0, 0)![0]).toBe(2);
      expect(live.source.get(0, 0)![1]).toBe(9);
      expect(changes).toHaveBeenLastCalledWith(expect.arrayContaining([{ tx: 0, ty: 0 }, { tx: 15, ty: 15 }]));
    });

    it('drops the realtime copy of a tile once its region is loaded', async () => {
      const { live, state, answers } = await signedIn();
      answers[0]!({ canvas_version: 1, tiles: [] });
      await flush();
      state.deltas[0]!([delta(1, 0, 9)]);
      expect(live.source.get(0, 0)![1]).toBe(9);
      // A cut, then the feed comes back: the region is asked again.
      state.config(null);
      expect(live.getState().status).toBe('error');
      state.config({ canvas_version: 1 });
      expect(answers).toHaveLength(2);
      answers[1]!({ canvas_version: 1, tiles: [{ tx: 0, ty: 0, colors: tile(4) }] });
      await flush();
      expect(live.source.get(0, 0)![1]).toBe(4);
    });

    it('asks the regions again after a network cut, and ends on the newest colour', async () => {
      const { live, state, answers } = await signedIn();
      answers[0]!({ canvas_version: 1, tiles: [{ tx: 0, ty: 0, colors: tile(2) }] });
      await flush();
      state.config({ canvas_version: 1 }, true);
      expect(live.getState().status).toBe('offline');
      expect(answers).toHaveLength(1);
      state.config({ canvas_version: 1 }, false);
      expect(live.getState().status).toBe('live');
      expect(answers).toHaveLength(2);
      // The listener resyncs what it missed, in any snapshot order: 9 then 5 on the same pixel.
      state.deltas[0]!([delta(1, 0, 5, 20), delta(1, 0, 9, 10)]);
      // The answer was read after both: it already shows 5. Replayed in order, 9 never wins.
      answers[1]!({ canvas_version: 1, tiles: [{ tx: 0, ty: 0, colors: tile(5) }] });
      await flush();
      expect(live.source.get(0, 0)![1]).toBe(5);
    });

    it('passes every realtime pixel on, and loads no region in the far view', async () => {
      const { live, state, fetcher } = await signedIn();
      const pixels = vi.fn();
      live.subscribePixels(pixels);
      state.deltas[0]!([delta(1, 0, 9)]);
      expect(pixels).toHaveBeenCalledWith([{ x: 1, y: 0, color: 9 }]);
      live.viewportChanged({ min_x: 5000, min_y: 0, max_x: 5100, max_y: 100 }, true);
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(live.getState().tiles).toBe('far');
    });

    it('forgets the tiles on sign-out and on a new canvas version', async () => {
      const { live, state, answers, fetcher, changes } = await signedIn();
      answers[0]!({ canvas_version: 1, tiles: [{ tx: 0, ty: 0, colors: tile(2) }] });
      await flush();
      state.config({ canvas_version: 2 });
      expect(changes).toHaveBeenLastCalledWith('all');
      expect(live.source.get(0, 0)).toBeNull();
      expect(fetcher).toHaveBeenCalledTimes(2);
      live.setTileFetcher(null);
      expect(live.getState().tiles).toBe('signed-out');
    });
  });
});
