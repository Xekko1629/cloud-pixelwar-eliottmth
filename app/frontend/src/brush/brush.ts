import { DEFAULT_MAX_BATCH_PIXELS, type DrawPixel } from '@pixelwar/shared/grid';
import { ApiError, type ApiClient } from '../api/client';
import { postPixels, type UserQuota } from '../api/grid';
import type { CanvasConfig } from '../realtime/feed';
import { MAX_BRUSH_SIZE, MIN_BRUSH_SIZE, Stroke, type BrushShape, type Point } from './stroke';

// The brush (WEB-05): a stroke is cut into POST /api/pixels requests of 500 pixels at most,
// sent while the stroke goes on. Same pipeline as one pixel: web-proxy publishes one
// pixel-draw event per pixel (ADR-0014), and the canvas only shows what the deltas bring.
//
// The refusals of a stroke are grouped in one message: after the stroke, /api/state says
// whether the last refusal belongs to one of its events.

export type StrokeStatus =
  | { status: 'idle' }
  | { status: 'drawing' | 'sending'; sent: number; covered: number }
  | { status: 'done'; sent: number; limited: boolean }
  | { status: 'rejected'; sent: number; reason: string }
  | { status: 'error'; sent: number; code: string };

export interface BrushState {
  size: number;
  shape: BrushShape;
  stroke: StrokeStatus;
}

export interface BrushContext {
  color(): number;
  config(): CanvasConfig | null;
  // Pixels the user may still draw this minute, null when unknown.
  remaining(): number | null;
  // Reads /api/state again; resolves with the new quota, or null.
  reloadQuota(): Promise<UserQuota | null>;
  // Out of quota as far as we know: asks the server again, on this try only.
  recheckQuota?(): Promise<void>;
  // Shows the pixels of the stroke at once, on the preview layer.
  preview?(pixels: readonly DrawPixel[]): void;
  // Takes back the preview of a refused stroke.
  forget?(pixels: readonly DrawPixel[]): void;
  // Counts the pixels sent against the known quota, before /api/state sees them.
  consume?(count: number): void;
}

export interface BrushOptions {
  // Requests in flight at once for one stroke.
  concurrency?: number;
  setTimer?: (callback: () => void, ms: number) => unknown;
  confirmAfterMs?: number;
}

export type BrushBlock = 'paused' | 'quota';

export class Brush {
  private state: BrushState = { size: 4, shape: 'square', stroke: { status: 'idle' } };
  private readonly listeners = new Set<() => void>();
  private readonly concurrency: number;
  private readonly setTimer: (callback: () => void, ms: number) => unknown;
  private readonly confirmAfterMs: number;
  private stroke: Stroke | null = null;
  private strokeId = 0;
  private inFlight = 0;
  private sent = 0;
  private ended = false;
  private failed: string | null = null;
  // The quota refused part of the stroke before publication (ADR-0017): stop sending.
  private refused: string | null = null;
  private eventIds = new Set<string>();
  private sentPixels: DrawPixel[] = [];

  constructor(private readonly api: ApiClient, private readonly context: BrushContext, options: BrushOptions = {}) {
    this.concurrency = options.concurrency ?? 4;
    this.setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
    this.confirmAfterMs = options.confirmAfterMs ?? 3000;
  }

  getState = (): BrushState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  setSize(size: number): void {
    const value = Math.round(size);
    if (Number.isFinite(value)) this.update({ size: Math.min(MAX_BRUSH_SIZE, Math.max(MIN_BRUSH_SIZE, value)) });
  }

  setShape(shape: BrushShape): void {
    this.update({ shape });
  }

  /** Why a stroke cannot start now, or null. */
  block(): BrushBlock | null {
    if (this.context.config()?.paused) return 'paused';
    if (this.context.remaining() === 0) return 'quota';
    return null;
  }

  begin(point: Point | null): void {
    if (point === null) return;
    // The server may allow more (new minute, /admin ratelimit): the next try will know.
    if (this.block() === 'quota') void this.context.recheckQuota?.();
    if (this.block() !== null) return;
    this.strokeId += 1;
    this.stroke = new Stroke({
      color: this.context.color(),
      size: this.state.size,
      shape: this.state.shape,
      grid: this.context.config()?.size ?? null,
      budget: this.context.remaining() ?? Number.POSITIVE_INFINITY,
    });
    // A previous stroke still sending goes on, but no longer reports.
    this.inFlight = 0;
    this.sent = 0;
    this.ended = false;
    this.failed = null;
    this.refused = null;
    this.eventIds = new Set();
    this.sentPixels = [];
    this.extend(point);
  }

  extend(point: Point | null): void {
    if (!this.stroke || this.ended || point === null) return;
    const added = this.stroke.moveTo(point);
    // Counted as soon as covered, so that a next stroke never starts on a stale quota.
    this.context.consume?.(added);
    this.context.preview?.(this.stroke.recent(added));
    this.pump();
    this.report();
  }

  /** The pointer is up: send what is left, then group the refusals. */
  end(): void {
    if (!this.stroke || this.ended) return;
    this.ended = true;
    this.pump();
    this.report();
  }

  // Sends full batches while the stroke goes on, and the rest once it has ended. After a
  // failure nothing more is sent.
  private pump(): void {
    const stroke = this.stroke;
    if (!stroke) return;
    while (this.failed === null && this.refused === null && this.inFlight < this.concurrency &&
      (stroke.pending >= DEFAULT_MAX_BATCH_PIXELS || (this.ended && stroke.pending > 0))) {
      void this.send(stroke.take(), this.strokeId);
    }
    if (this.ended && this.inFlight === 0) this.finish();
  }

  private async send(pixels: ReturnType<Stroke['take']>, id: number): Promise<void> {
    this.inFlight += 1;
    try {
      const accepted = await postPixels(this.api, pixels);
      if (id !== this.strokeId) return;
      for (const eventId of accepted.eventIds) this.eventIds.add(eventId);
      // Only the first pixels of the request may be granted: the others will never be drawn.
      const granted = pixels.slice(0, accepted.eventIds.length);
      this.sent += granted.length;
      this.sentPixels.push(...granted);
      if (accepted.refused) {
        this.context.forget?.(pixels.slice(granted.length));
        this.refused ??= accepted.refused.reason;
      }
    } catch (error) {
      if (id !== this.strokeId) return;
      if (error instanceof ApiError && error.status === 429) {
        // Refused before publication: certain, unlike a failure. Nothing of it will be drawn.
        this.context.forget?.(pixels);
        this.refused ??= error.code;
      } else {
        // The rest of the stroke is dropped, never sent again automatically: the outcome
        // of a failed request is uncertain (docs/web-proxy.md).
        this.failed ??= typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : 'network';
      }
    } finally {
      if (id === this.strokeId) this.inFlight -= 1;
    }
    if (id !== this.strokeId) return;
    this.pump();
    this.report();
  }

  private finish(): void {
    const stroke = this.stroke!;
    const id = this.strokeId;
    this.stroke = null;
    if (this.failed !== null) {
      this.setStroke({ status: 'error', sent: this.sent, code: this.failed });
      void this.context.reloadQuota();
      return;
    }
    if (this.refused !== null) {
      this.setStroke({ status: 'rejected', sent: this.sent, reason: this.refused });
      void this.context.reloadQuota();
      return;
    }
    this.setStroke({ status: 'done', sent: this.sent, limited: stroke.exhausted });
    if (this.sent === 0) return;
    const events = this.eventIds;
    const pixels = this.sentPixels;
    this.setTimer(() => void this.confirm(id, events, pixels), this.confirmAfterMs);
  }

  private async confirm(id: number, events: Set<string>, pixels: DrawPixel[]): Promise<void> {
    const quota = await this.context.reloadQuota();
    const rejection = quota?.lastRejection;
    if (!rejection || !events.has(rejection.eventId)) return;
    // Part of the stroke was refused: what is not on the canvas by now will not come.
    this.context.forget?.(pixels);
    if (id === this.strokeId) this.setStroke({ status: 'rejected', sent: this.sent, reason: rejection.reason });
  }

  private report(): void {
    if (!this.stroke) return;
    this.setStroke({ status: this.ended ? 'sending' : 'drawing', sent: this.sent, covered: this.stroke.count });
  }

  private setStroke(stroke: StrokeStatus): void {
    this.update({ stroke });
  }

  private update(patch: Partial<BrushState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
}
