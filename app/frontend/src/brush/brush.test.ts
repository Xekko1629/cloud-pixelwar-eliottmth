import { describe, expect, it, vi } from 'vitest';
import { ApiClient } from '../api/client';
import type { UserQuota } from '../api/grid';
import { SESSION_KEY, SessionStore } from '../auth/session';
import { TOKEN, USER, jsonResponse, memoryStorage } from '../auth/testing';
import type { CanvasConfig } from '../realtime/feed';
import { strokeText } from '../inspect/PixelPanel';
import { Brush, type BrushContext } from './brush';

const flush = async () => {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

function setup(options: { config?: Partial<CanvasConfig>; remaining?: number | null; answer?: () => Response } = {}) {
  let next = 0;
  const bodies: Array<{ pixels: Array<{ x: number; y: number; color: number }> }> = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
    const body = JSON.parse(init?.body as string) as (typeof bodies)[number];
    bodies.push(body);
    if (options.answer) return options.answer();
    return jsonResponse(202, { correlation_id: 'c', event_ids: body.pixels.map(() => `e-${next++}`) });
  });
  const session = JSON.stringify({ token: TOKEN, expiresAt: Date.now() + 15 * 60_000, user: USER });
  const api = new ApiClient({ baseUrl: 'https://gw.example.dev', sessions: new SessionStore(memoryStorage({ [SESSION_KEY]: session })), fetch });
  let quota: UserQuota | null = null;
  const context: BrushContext = {
    color: () => 7,
    config: () => ({ paused: false, canvasVersion: 1, size: null, bounds: null, ...options.config }),
    remaining: () => (options.remaining === undefined ? 1_000_000 : options.remaining),
    reloadQuota: vi.fn(async () => quota),
    preview: vi.fn(),
  };
  const timers: Array<() => void> = [];
  const brush = new Brush(api, context, { setTimer: (callback) => timers.push(callback) });
  return { brush, bodies, fetch, context, timers, setQuota: (value: UserQuota) => { quota = value; } };
}

describe('Brush', () => {
  it('sends full batches during the stroke and the rest at the end, each pixel once', async () => {
    const { brush, bodies } = setup();
    brush.setSize(30);
    brush.begin({ x: 0, y: 0 });
    await flush();
    // 900 pixels: one full batch leaves at once, the rest waits for the end.
    expect(bodies).toHaveLength(1);
    expect(brush.getState().stroke).toMatchObject({ status: 'drawing', covered: 900 });
    brush.end();
    await flush();
    expect(bodies.map((b) => b.pixels.length)).toEqual([500, 400]);
    const all = bodies.flatMap((b) => b.pixels.map((p) => `${p.x},${p.y}`));
    expect(new Set(all).size).toBe(900);
    expect(bodies[0]!.pixels[0]!.color).toBe(7);
    expect(brush.getState().stroke).toEqual({ status: 'done', sent: 900, limited: false });
    expect(strokeText(brush.getState().stroke)).toBe('Trait envoyé : 900 pixels.');
  });

  it('shows every covered pixel at once on the preview, before any answer', () => {
    const { brush, context } = setup();
    brush.setSize(3);
    brush.begin({ x: 0, y: 0 });
    brush.extend({ x: 1, y: 0 });
    const shown = vi.mocked(context.preview!).mock.calls.flatMap(([pixels]) => pixels);
    expect(shown).toHaveLength(12);
    expect(shown.every((p) => p.color === 7)).toBe(true);
  });

  it('groups the refusals of a stroke in one message', async () => {
    const { brush, timers, setQuota } = setup();
    brush.setSize(2);
    brush.begin({ x: 0, y: 0 });
    brush.extend({ x: 5, y: 0 });
    brush.end();
    await flush();
    setQuota({ limitPerMinute: 20, usedPixels: 20, remainingPixels: 0, resetAt: new Date(), lastRejection: { eventId: 'e-3', reason: 'rate_limit', at: new Date() } });
    timers[0]!();
    await flush();
    // Size 2 from x 0 to x 5: 7 columns of 2 pixels.
    expect(brush.getState().stroke).toEqual({ status: 'rejected', sent: 14, reason: 'rate_limit' });
    expect(strokeText(brush.getState().stroke)).toBe('Trait envoyé : 14 pixels, une partie refusée : quota de pixels dépassé.');
  });

  it('stops sending after a failed request, without sending it again', async () => {
    const { brush, bodies } = setup({ answer: () => jsonResponse(503, { error: 'publish_unavailable' }) });
    brush.setSize(40);
    // 1 600 pixels: three full batches leave together, then all fail.
    brush.begin({ x: 0, y: 0 });
    await flush();
    expect(bodies).toHaveLength(3);
    brush.extend({ x: 40, y: 0 });
    brush.end();
    await flush();
    expect(bodies).toHaveLength(3);
    expect(brush.getState().stroke).toMatchObject({ status: 'error', sent: 0, code: 'publish_unavailable' });
  });

  it('does not start while paused or without quota, and stops at the known quota', async () => {
    const paused = setup({ config: { paused: true } });
    paused.brush.begin({ x: 0, y: 0 });
    expect(paused.brush.block()).toBe('paused');
    expect(paused.fetch).not.toHaveBeenCalled();

    expect(setup({ remaining: 0 }).brush.block()).toBe('quota');

    const limited = setup({ remaining: 3 });
    limited.brush.setSize(5);
    limited.brush.begin({ x: 0, y: 0 });
    limited.brush.end();
    await flush();
    expect(limited.bodies[0]!.pixels).toHaveLength(3);
    expect(limited.brush.getState().stroke).toEqual({ status: 'done', sent: 3, limited: true });
  });

  it('keeps the size between 1 and 100', () => {
    const { brush } = setup();
    brush.setSize(0);
    expect(brush.getState().size).toBe(1);
    brush.setSize(250);
    expect(brush.getState().size).toBe(100);
  });
});
