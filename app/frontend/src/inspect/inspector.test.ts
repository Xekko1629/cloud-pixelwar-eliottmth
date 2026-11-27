import { TILE_PIXELS } from '@pixelwar/shared/grid';
import { describe, expect, it, vi } from 'vitest';
import { ApiClient } from '../api/client';
import { SESSION_KEY, SessionStore } from '../auth/session';
import { TOKEN, USER, jsonResponse, memoryStorage } from '../auth/testing';
import type { CanvasConfig } from '../realtime/feed';
import type { TileChange } from '../realtime/live';
import { feedbackText } from './PixelPanel';
import { PixelInspector, remainingPixels } from './inspector';

const NOW = Date.parse('2026-11-26T10:01:30.000Z');
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function quota(remaining = 15, rejection: unknown = null) {
  return {
    canvas_version: 1, paused: false, size: null, bounds: null, region_side: 1024,
    user: { limit_per_minute: 20, used_pixels: 20 - remaining, remaining_pixels: remaining, reset_at: '2026-11-26T10:02:00.000Z', last_rejection: rejection },
  };
}

function setup(options: { config?: Partial<CanvasConfig>; remaining?: number } = {}) {
  const routes = {
    meta: () => jsonResponse(200, { canvas_version: 1, tx: 0, ty: 0, tile_side: 64, pixels: { 65: { name: 'Eliott', at: '2026-11-26T10:00:00.000Z' } } }),
    state: () => jsonResponse(200, quota(options.remaining)),
    pixels: () => jsonResponse(202, { correlation_id: 'c-1', event_ids: ['e-1'] }),
  };
  const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
    const url = String(input);
    if (url.endsWith('/meta')) return routes.meta();
    if (url.endsWith('/api/state')) return routes.state();
    return routes.pixels();
  });
  const session = JSON.stringify({ token: TOKEN, expiresAt: NOW + 15 * 60_000, user: USER });
  const sessions = new SessionStore(memoryStorage({ [SESSION_KEY]: session }), () => NOW);
  const api = new ApiClient({ baseUrl: 'https://gw.example.dev', sessions, fetch, now: () => NOW });

  const tile = new Uint8Array(TILE_PIXELS);
  tile[65] = 3;
  let listener: (change: TileChange) => void = () => {};
  const config: CanvasConfig = { paused: false, canvasVersion: 1, size: null, bounds: null, ...options.config };
  const canvas = {
    source: { get: (tx: number, ty: number) => (tx === 0 && ty === 0 ? tile : null) },
    subscribe: (next: (change: TileChange) => void) => { listener = next; return () => {}; },
    getState: () => ({ config }),
  };
  const timers: Array<{ callback: () => void; ms: number; cleared: boolean }> = [];
  const inspector = new PixelInspector(api, canvas, {
    now: () => NOW,
    setTimer: (callback, ms) => { const timer = { callback, ms, cleared: false }; timers.push(timer); return timer; },
    clearTimer: (timer) => { (timer as { cleared: boolean }).cleared = true; },
  });
  const fire = (ms: number) => timers.filter((t) => t.ms === ms && !t.cleared).forEach((t) => { t.cleared = true; t.callback(); });
  return { inspector, fetch, routes, tile, change: (c: TileChange) => listener(c), fire };
}

describe('PixelInspector', () => {
  it('shows the colour and the author of the selected pixel', async () => {
    const { inspector, fetch } = setup();
    inspector.start();
    inspector.select({ x: 1, y: 1 });
    expect(inspector.getState()).toMatchObject({ selected: { x: 1, y: 1 }, color: 3, meta: 'loading' });
    await flush();
    expect(fetch.mock.calls.map(([url]) => String(url))).toContain('https://gw.example.dev/api/tiles/0/0/meta');
    expect(inspector.getState().author).toEqual({ name: 'Eliott', at: new Date('2026-11-26T10:00:00.000Z') });
    expect(inspector.getState().quota?.remainingPixels).toBe(15);

    inspector.select({ x: 2, y: 2 });
    await flush();
    expect(inspector.getState()).toMatchObject({ color: 0, author: null, meta: 'ready' });
    inspector.select(null);
    expect(inspector.getState().selected).toBeNull();
  });

  it('reads the author again after a delta on its tile, once per burst', async () => {
    const { inspector, fetch, change, fire } = setup();
    inspector.start();
    inspector.select({ x: 1, y: 1 });
    await flush();
    const metaCalls = () => fetch.mock.calls.filter(([url]) => String(url).endsWith('/meta')).length;
    change([{ tx: 5, ty: 5 }]);
    change([{ tx: 0, ty: 0 }]);
    change([{ tx: 0, ty: 0 }]);
    fire(300);
    await flush();
    expect(metaCalls()).toBe(2);
  });

  it('draws the pixel and confirms it when its delta arrives', async () => {
    const { inspector, fetch, tile, change } = setup();
    inspector.start();
    inspector.select({ x: 1, y: 1 });
    inspector.setBrushColor(9);
    await inspector.draw();
    expect(inspector.getState().feedback).toEqual({ status: 'waiting', eventId: 'e-1' });
    const post = fetch.mock.calls.find(([url]) => String(url).endsWith('/api/pixels'))!;
    expect(JSON.parse(post[1]?.body as string)).toEqual({ pixels: [{ x: 1, y: 1, color: 9 }] });
    tile[65] = 9;
    change([{ tx: 0, ty: 0 }]);
    expect(inspector.getState().feedback).toEqual({ status: 'drawn' });
    expect(feedbackText(inspector.getState().feedback)).toBe('Pixel posé.');
  });

  it('reports the refusal of the worker when no delta comes', async () => {
    const { inspector, routes, fire } = setup();
    inspector.start();
    inspector.select({ x: 1, y: 1 });
    await inspector.draw();
    routes.state = () => jsonResponse(200, quota(0, { event_id: 'e-1', reason: 'rate_limit', at: '2026-11-26T10:01:31.000Z' }));
    fire(3000);
    await flush();
    await flush();
    expect(inspector.getState().feedback).toEqual({ status: 'rejected', reason: 'rate_limit' });
    expect(feedbackText(inspector.getState().feedback)).toBe('Refusé : quota de pixels dépassé.');
    expect(inspector.drawBlock()).toBe('quota');
  });

  it('stays pending when neither the delta nor a refusal is there yet', async () => {
    const { inspector, fire } = setup();
    inspector.start();
    inspector.select({ x: 1, y: 1 });
    await inspector.draw();
    fire(3000);
    await flush();
    await flush();
    expect(inspector.getState().feedback).toEqual({ status: 'pending' });
  });

  it('shows a failed request without sending it again', async () => {
    const { inspector, routes, fetch } = setup();
    routes.pixels = () => jsonResponse(503, { error: 'publish_unavailable' });
    inspector.select({ x: 1, y: 1 });
    await inspector.draw();
    expect(inspector.getState().feedback).toEqual({ status: 'error', code: 'publish_unavailable' });
    expect(fetch.mock.calls.filter(([url]) => String(url).endsWith('/api/pixels'))).toHaveLength(1);
  });

  it.each([
    [{ config: { paused: true } }, 'paused'],
    [{ config: { size: { width: 10_000, height: 10_000 } } }, 'outside'],
  ] as const)('does not draw when blocked: %o', async (options, block) => {
    const { inspector, fetch } = setup(options);
    inspector.select({ x: -1, y: 1 });
    expect(inspector.drawBlock()).toBe(block);
    await inspector.draw();
    expect(fetch.mock.calls.some(([url]) => String(url).endsWith('/api/pixels'))).toBe(false);
  });

  it('needs a selected pixel', () => {
    expect(setup().inspector.drawBlock()).toBe('no_selection');
  });
});

describe('remainingPixels', () => {
  it('gives the whole limit back after reset_at', () => {
    const value = { limitPerMinute: 20, usedPixels: 20, remainingPixels: 0, resetAt: new Date(NOW + 1000), lastRejection: null };
    expect(remainingPixels(value, NOW)).toBe(0);
    expect(remainingPixels(value, NOW + 1000)).toBe(20);
  });
});
