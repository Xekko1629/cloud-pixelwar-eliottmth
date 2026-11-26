import { encodeDelta } from '@pixelwar/shared/grid';
import { describe, expect, it, vi } from 'vitest';
import type { TileColorsSource } from '../canvas/tiles';
import type { FirestoreBackend } from './feed';
import { LiveCanvas } from './live';

const empty: TileColorsSource = { get: () => null };

function backend() {
  const state = {
    config: (_data: unknown) => {},
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

const delta = (x: number, y: number, color: number) => ({
  encoding_version: 1, canvas_version: 1, region: '0_0', event_id: 'e',
  created_at: { toMillis: () => 1 }, pixels: encodeDelta([{ x, y, color }]),
});

describe('LiveCanvas', () => {
  it('is disabled without a Firestore configuration', async () => {
    const live = new LiveCanvas(empty, null);
    await live.start();
    expect(live.getState()).toEqual({ status: 'disabled', config: null });
  });

  it('reports a SDK that cannot be loaded', async () => {
    const live = new LiveCanvas(empty, () => Promise.reject(new Error('offline')));
    await live.start();
    expect(live.getState().status).toBe('error');
  });

  it('follows the viewport given before the SDK loaded, and repaints the touched tiles', async () => {
    const { fake, state } = backend();
    const live = new LiveCanvas(empty, async () => fake, {
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
      status: 'live', config: { paused: true, canvasVersion: 1, size: null, bounds: null },
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
});
