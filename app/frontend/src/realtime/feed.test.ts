import { encodeDelta } from '@pixelwar/shared/grid';
import { describe, expect, it, vi } from 'vitest';
import {
  RealtimeFeed, parseCanvasConfig, parseDelta, visibleRegions, type DeltaQuery, type FirestoreBackend,
} from './feed';

const NOW = Date.parse('2026-11-25T10:00:00Z');
const timestamp = (ms: number) => ({ toMillis: () => ms });
const bytes = (array: Uint8Array) => ({ toUint8Array: () => array });

function delta(overrides: Record<string, unknown> = {}) {
  return {
    encoding_version: 1, canvas_version: 1, region: '0_0', event_id: 'e1',
    created_at: timestamp(NOW), pixels: bytes(encodeDelta([{ x: 3, y: 4, color: 5 }])),
    ...overrides,
  };
}

describe('parseCanvasConfig', () => {
  it('reads config/global', () => {
    expect(parseCanvasConfig({
      paused: true, canvas_version: 3, size: { width: 10_000, height: 20_000 },
      bounds: { min_x: -5, min_y: 0, max_x: 9, max_y: 12 }, default_limit_per_minute: 20,
    })).toEqual({
      paused: true, canvasVersion: 3, size: { width: 10_000, height: 20_000 },
      bounds: { min_x: -5, min_y: 0, max_x: 9, max_y: 12 },
    });
  });

  it('treats missing or invalid optional fields as absent', () => {
    expect(parseCanvasConfig({ canvas_version: 1, paused: 'yes', size: { width: 0 }, bounds: { min_x: 'a' } }))
      .toEqual({ paused: false, canvasVersion: 1, size: null, bounds: null });
  });

  it.each([null, undefined, [], {}, { canvas_version: 0 }, { canvas_version: 1.5 }])('refuses %j', (raw) => {
    expect(parseCanvasConfig(raw)).toBeNull();
  });
});

describe('parseDelta', () => {
  it('converts region coordinates to absolute ones', () => {
    expect(parseDelta(delta({ region: '-2_1' }))).toEqual({
      canvasVersion: 1, region: '-2_1', createdAt: NOW, pixels: [{ x: -2048 + 3, y: 1024 + 4, color: 5 }],
    });
  });

  it('accepts a plain Uint8Array', () => {
    expect(parseDelta(delta({ pixels: encodeDelta([{ x: 0, y: 0, color: 1 }]) }))?.pixels).toEqual([{ x: 0, y: 0, color: 1 }]);
  });

  it.each([
    ['another encoding', { encoding_version: 2 }],
    ['no version', { canvas_version: undefined }],
    ['a malformed region', { region: 'a_b' }],
    ['a region outside the grid', { region: '976563_0' }],
    ['no timestamp', { created_at: '2026-11-25' }],
    ['a broken timestamp', { created_at: { toMillis: () => Number.NaN } }],
    ['no pixels', { pixels: 'AAAA' }],
    ['a non-array blob', { pixels: { toUint8Array: () => 'x' } }],
    ['corrupted pixels', { pixels: new Uint8Array([1, 2, 3]) }],
  ])('refuses %s', (_label, overrides) => {
    expect(parseDelta(delta(overrides))).toBeNull();
  });

  it('refuses something that is not a document', () => {
    expect(parseDelta(null)).toBeNull();
  });
});

describe('visibleRegions', () => {
  it('lists the regions of the visible pixels, negative ones included', () => {
    expect(visibleRegions({ min_x: -10, min_y: 0, max_x: 1030, max_y: 100 })).toEqual(['-1_0', '0_0', '1_0']);
  });

  it('switches to every region past 30 (Firestore `in` limit)', () => {
    expect(visibleRegions({ min_x: 0, min_y: 0, max_x: 5 * 1024 - 1, max_y: 6 * 1024 - 1 })).toHaveLength(30);
    expect(visibleRegions({ min_x: 0, min_y: 0, max_x: 6 * 1024 - 1, max_y: 6 * 1024 - 1 })).toBeNull();
  });
});

function fakeBackend() {
  const config = { next: (_data: unknown, _fromCache?: boolean) => {}, error: (_error: unknown) => {}, stopped: false };
  const listeners: Array<{ query: DeltaQuery; added: (docs: unknown[], fromCache?: boolean) => void; error: (e: unknown) => void; stopped: boolean }> = [];
  const backend: FirestoreBackend = {
    watchConfig(next, error) {
      Object.assign(config, { next, error });
      return () => { config.stopped = true; };
    },
    watchDeltas(query, added, error) {
      const listener = { query, added, error, stopped: false };
      listeners.push(listener);
      return () => { listener.stopped = true; };
    },
  };
  const active = () => listeners.filter((listener) => !listener.stopped);
  return { backend, config, listeners, active };
}

function setup() {
  const fake = fakeBackend();
  const handlers = { config: vi.fn(), deltas: vi.fn(), reset: vi.fn(), status: vi.fn() };
  const timers: Array<{ callback: () => void; ms: number; cleared: boolean }> = [];
  const feed = new RealtimeFeed(fake.backend, handlers, {
    now: () => NOW,
    setTimer: (callback, ms) => {
      const timer = { callback: () => { timer.cleared = true; callback(); }, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => { (timer as { cleared: boolean }).cleared = true; },
  });
  const fire = () => { for (const timer of timers.filter((t) => !t.cleared)) timer.callback(); };
  return { ...fake, handlers, feed, timers, fire };
}

const VIEW = { min_x: 0, min_y: 0, max_x: 500, max_y: 500 };

describe('RealtimeFeed', () => {
  it('opens the deltas listener once the configuration and the viewport are known', () => {
    const { feed, config, listeners, handlers, fire } = setup();
    feed.start();
    expect(handlers.status).toHaveBeenLastCalledWith('connecting');
    feed.setViewport(VIEW);
    fire();
    expect(listeners).toHaveLength(0);
    config.next({ canvas_version: 2, paused: false });
    expect(handlers.config).toHaveBeenCalledWith({ paused: false, canvasVersion: 2, size: null, bounds: null });
    expect(handlers.status).toHaveBeenLastCalledWith('live');
    expect(listeners).toHaveLength(1);
    expect(listeners[0]!.query).toEqual({ canvasVersion: 2, regions: ['0_0'], since: NOW - 30_000 });
  });

  it('delivers the deltas of the current version, oldest first', () => {
    const { feed, config, listeners, handlers, fire } = setup();
    feed.start();
    config.next({ canvas_version: 1 });
    feed.setViewport(VIEW);
    fire();
    listeners[0]!.added([
      delta({ created_at: timestamp(NOW + 2) }),
      delta({ created_at: timestamp(NOW + 1), pixels: bytes(encodeDelta([{ x: 3, y: 4, color: 9 }])) }),
      delta({ canvas_version: 0 }),
      { broken: true },
    ]);
    expect(handlers.deltas).toHaveBeenCalledOnce();
    expect(handlers.deltas.mock.calls[0]![0].map((d: { createdAt: number }) => d.createdAt)).toEqual([NOW + 1, NOW + 2]);
    listeners[0]!.added([]);
    expect(handlers.deltas).toHaveBeenCalledOnce();
  });

  it('follows the viewport only when its regions change, after the pan settles', () => {
    const { feed, config, listeners, active, timers, fire } = setup();
    feed.start();
    config.next({ canvas_version: 1 });
    feed.setViewport(VIEW);
    expect(timers[0]!.ms).toBe(0);
    fire();
    feed.setViewport({ ...VIEW, max_x: 600 });
    expect(timers.filter((t) => !t.cleared)).toHaveLength(0);
    feed.setViewport({ ...VIEW, max_x: 1500 });
    feed.setViewport({ ...VIEW, max_x: 2500 });
    expect(timers.filter((t) => !t.cleared)).toHaveLength(1);
    expect(timers.at(-1)!.ms).toBe(250);
    fire();
    expect(listeners).toHaveLength(2);
    expect(active()).toEqual([listeners[1]]);
    expect(listeners[1]!.query.regions).toEqual(['0_0', '1_0', '2_0']);
  });

  it('listens to every region in the far view', () => {
    const { feed, config, listeners, fire } = setup();
    feed.start();
    config.next({ canvas_version: 1 });
    feed.setViewport({ min_x: -50_000, min_y: -50_000, max_x: 50_000, max_y: 50_000 });
    fire();
    expect(listeners[0]!.query.regions).toBeNull();
  });

  it('drops a late snapshot of a replaced listener', () => {
    const { feed, config, listeners, handlers, fire } = setup();
    feed.start();
    config.next({ canvas_version: 1 });
    feed.setViewport(VIEW);
    fire();
    feed.setViewport({ ...VIEW, max_x: 1500 });
    fire();
    listeners[0]!.added([delta()]);
    listeners[0]!.error(new Error('late'));
    expect(handlers.deltas).not.toHaveBeenCalled();
    expect(handlers.status).not.toHaveBeenCalledWith('error');
  });

  it('resets the canvas and listens to the new version after /admin clear', () => {
    const { feed, config, listeners, active, handlers, fire } = setup();
    feed.start();
    config.next({ canvas_version: 1 });
    feed.setViewport(VIEW);
    fire();
    config.next({ canvas_version: 1, paused: true });
    expect(handlers.reset).not.toHaveBeenCalled();
    expect(listeners).toHaveLength(1);
    config.next({ canvas_version: 2 });
    expect(handlers.reset).toHaveBeenCalledWith({ paused: false, canvasVersion: 2, size: null, bounds: null });
    expect(active()).toHaveLength(1);
    expect(active()[0]!.query.canvasVersion).toBe(2);
  });

  it('reports a network cut as offline, keeps the configuration, and is live again after it', () => {
    const { feed, config, listeners, handlers, fire } = setup();
    feed.start();
    config.next({ canvas_version: 1 });
    feed.setViewport(VIEW);
    fire();
    config.next({ canvas_version: 1 }, true);
    expect(handlers.status).toHaveBeenLastCalledWith('offline');
    expect(handlers.config).toHaveBeenCalledTimes(1);
    // A snapshot of the deltas from the cache does not mean the connection is back.
    listeners[0]!.added([], true);
    expect(handlers.status).toHaveBeenLastCalledWith('offline');
    config.next({ canvas_version: 1 }, false);
    expect(handlers.status).toHaveBeenLastCalledWith('live');
    expect(listeners).toHaveLength(1);
  });

  it('reports errors of either listener, and an invalid configuration', () => {
    const { feed, config, listeners, handlers, fire } = setup();
    feed.start();
    config.next({});
    expect(handlers.status).toHaveBeenLastCalledWith('error');
    config.next({ canvas_version: 1 });
    feed.setViewport(VIEW);
    fire();
    listeners[0]!.error(new Error('failed-precondition'));
    expect(handlers.status).toHaveBeenLastCalledWith('error');
    config.error(new Error('permission-denied'));
    expect(handlers.status).toHaveBeenLastCalledWith('error');
  });

  it('closes every listener and pending timer on stop, and starts only once', () => {
    const { feed, config, active, timers, fire } = setup();
    feed.start();
    feed.start();
    config.next({ canvas_version: 1 });
    feed.setViewport(VIEW);
    fire();
    feed.setViewport({ ...VIEW, max_x: 1500 });
    feed.stop();
    expect(config.stopped).toBe(true);
    expect(active()).toHaveLength(0);
    expect(timers.every((timer) => timer.cleared)).toBe(true);
  });

  it('works with the default timers', async () => {
    const fake = fakeBackend();
    const feed = new RealtimeFeed(fake.backend);
    feed.start();
    fake.config.next({ canvas_version: 1 });
    feed.setViewport(VIEW);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fake.listeners).toHaveLength(1);
    feed.setViewport({ ...VIEW, max_x: 1500 });
    feed.stop();
  });
});
