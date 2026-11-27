import { isInsideGrid, locatePixel } from '@pixelwar/shared/grid';
import type { ApiClient } from '../api/client';
import { fetchTileMeta, fetchUserQuota, postPixels, type PixelAuthor, type UserQuota } from '../api/grid';
import type { TileColorsSource } from '../canvas/tiles';
import type { CanvasConfig } from '../realtime/feed';
import type { TileChange } from '../realtime/live';

// Selected pixel, its author, and drawing one pixel from the site (WEB-04).
//
// No polling: the author is read when a pixel is selected and again when a realtime delta
// changes its tile; the quota is read at start and after each draw. A draw is "drawn"
// when its delta repaints the pixel; without it after a few seconds, /api/state tells
// whether the worker refused it (last_rejection).

export interface Point {
  x: number;
  y: number;
}

export type DrawFeedback =
  | { status: 'idle' }
  | { status: 'sending' }
  | { status: 'waiting'; eventId: string }
  | { status: 'drawn' }
  // Accepted by the gateway, but neither drawn nor refused yet.
  | { status: 'pending' }
  | { status: 'rejected'; reason: string }
  | { status: 'error'; code: string };

export interface InspectorState {
  selected: Point | null;
  // Colour of the selected pixel on the canvas, 0 when never painted.
  color: number;
  author: PixelAuthor | null;
  meta: 'idle' | 'loading' | 'ready' | 'error';
  brushColor: number;
  quota: UserQuota | null;
  feedback: DrawFeedback;
}

export interface CanvasSource {
  readonly source: TileColorsSource;
  subscribe(listener: (change: TileChange) => void): () => void;
  getState(): { config: CanvasConfig | null };
}

export interface InspectorOptions {
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
  // Delay before asking /api/state why a draw is not on the canvas yet.
  confirmAfterMs?: number;
  // Coalesces the author reloads of a busy tile.
  metaDebounceMs?: number;
}

export type DrawBlock = 'paused' | 'outside' | 'quota' | 'busy' | 'no_selection';

export class PixelInspector {
  private state: InspectorState = {
    selected: null, color: 0, author: null, meta: 'idle', brushColor: 1, quota: null, feedback: { status: 'idle' },
  };
  private readonly listeners = new Set<() => void>();
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, ms: number) => unknown;
  private readonly clearTimer: (timer: unknown) => void;
  private readonly confirmAfterMs: number;
  private readonly metaDebounceMs: number;
  private metaToken = 0;
  private metaTimer: unknown = null;
  private confirmTimer: unknown = null;
  private resetTimer: unknown = null;
  private sentColor = 0;
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly api: ApiClient, private readonly canvas: CanvasSource, options: InspectorOptions = {}) {
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
    this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
    this.confirmAfterMs = options.confirmAfterMs ?? 3000;
    this.metaDebounceMs = options.metaDebounceMs ?? 300;
  }

  getState = (): InspectorState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Follows the canvas and reads the quota once. */
  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.canvas.subscribe((change) => this.onCanvasChange(change));
    void this.refreshQuota();
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const timer of [this.metaTimer, this.confirmTimer, this.resetTimer]) if (timer !== null) this.clearTimer(timer);
    this.metaTimer = this.confirmTimer = this.resetTimer = null;
  }

  select(point: Point | null): void {
    this.metaToken += 1;
    if (point === null) {
      this.update({ selected: null, color: 0, author: null, meta: 'idle' });
      return;
    }
    this.update({ selected: point, color: this.colorAt(point), author: null, meta: 'loading' });
    void this.loadMeta();
  }

  setBrushColor(color: number): void {
    if (Number.isInteger(color) && color >= 1 && color <= 16) this.update({ brushColor: color });
  }

  /** Why the selected pixel cannot be drawn now, or null. The server decides anyway. */
  drawBlock(): DrawBlock | null {
    const { selected, quota, feedback } = this.state;
    if (!selected) return 'no_selection';
    if (feedback.status === 'sending') return 'busy';
    const config = this.canvas.getState().config;
    if (config?.paused) return 'paused';
    if (config && !isInsideGrid(selected, config.size)) return 'outside';
    if (quota && remainingPixels(quota, this.now()) === 0) return 'quota';
    return null;
  }

  async draw(): Promise<void> {
    const selected = this.state.selected;
    if (!selected || this.drawBlock() !== null) return;
    const color = this.state.brushColor;
    if (this.confirmTimer !== null) this.clearTimer(this.confirmTimer);
    this.confirmTimer = null;
    this.update({ feedback: { status: 'sending' } });
    try {
      const accepted = await postPixels(this.api, [{ x: selected.x, y: selected.y, color }]);
      const eventId = accepted.eventIds[0]!;
      this.sentColor = color;
      this.update({ feedback: { status: 'waiting', eventId } });
      this.confirmTimer = this.setTimer(() => void this.confirm(eventId), this.confirmAfterMs);
    } catch (error) {
      // Never sent again automatically: a lost 202 would make a second stroke (web-proxy.md).
      const code = typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : 'network';
      this.update({ feedback: { status: 'error', code } });
    }
  }

  private async confirm(eventId: string): Promise<void> {
    this.confirmTimer = null;
    const feedback = this.state.feedback;
    if (feedback.status !== 'waiting' || feedback.eventId !== eventId) return;
    const quota = await this.refreshQuota();
    const current = this.state.feedback;
    if (current.status !== 'waiting' || current.eventId !== eventId) return;
    if (quota?.lastRejection?.eventId === eventId) this.update({ feedback: { status: 'rejected', reason: quota.lastRejection.reason } });
    else this.update({ feedback: { status: 'pending' } });
  }

  private onCanvasChange(change: TileChange): void {
    const selected = this.state.selected;
    if (!selected) return;
    const { tx, ty } = locatePixel(selected.x, selected.y);
    if (change !== 'all' && !change.some((tile) => tile.tx === tx && tile.ty === ty)) return;
    const color = this.colorAt(selected);
    this.update({ color });
    const feedback = this.state.feedback;
    if (feedback.status === 'waiting' && color === this.sentColor) {
      if (this.confirmTimer !== null) this.clearTimer(this.confirmTimer);
      this.confirmTimer = null;
      this.update({ feedback: { status: 'drawn' } });
      void this.refreshQuota();
    }
    // The author changed too: read it again once the burst of deltas is over.
    if (this.metaTimer !== null) this.clearTimer(this.metaTimer);
    const token = this.metaToken;
    this.metaTimer = this.setTimer(() => {
      this.metaTimer = null;
      if (token === this.metaToken) void this.loadMeta();
    }, this.metaDebounceMs);
  }

  private async loadMeta(): Promise<void> {
    const selected = this.state.selected;
    if (!selected) return;
    const token = this.metaToken;
    const { tx, ty, index } = locatePixel(selected.x, selected.y);
    try {
      const meta = await fetchTileMeta(this.api, tx, ty);
      if (token !== this.metaToken) return;
      this.update({ author: meta.pixels.get(index) ?? null, meta: 'ready' });
    } catch {
      if (token === this.metaToken) this.update({ meta: 'error' });
    }
  }

  private async refreshQuota(): Promise<UserQuota | null> {
    try {
      const quota = await fetchUserQuota(this.api);
      this.update({ quota });
      // Redraw the panel when the minute ends: the quota is full again.
      if (this.resetTimer !== null) this.clearTimer(this.resetTimer);
      const wait = quota.resetAt.getTime() - this.now();
      this.resetTimer = wait > 0 && quota.remainingPixels === 0
        ? this.setTimer(() => { this.resetTimer = null; this.update({}); }, wait)
        : null;
      return quota;
    } catch {
      return null;
    }
  }

  private colorAt(point: Point): number {
    const { tx, ty, index } = locatePixel(point.x, point.y);
    return this.canvas.source.get(tx, ty)?.[index] ?? 0;
  }

  private update(patch: Partial<InspectorState>): void {
    this.state = { ...this.state, ...patch };
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

/** The quota counts per calendar minute: after reset_at, the whole limit is back. */
export function remainingPixels(quota: UserQuota, now: number): number {
  return now >= quota.resetAt.getTime() ? quota.limitPerMinute : quota.remainingPixels;
}
