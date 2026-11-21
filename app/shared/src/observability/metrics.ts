import type { Meter } from '@opentelemetry/api';

export type PixelSource = 'web' | 'discord';
export type RejectionReason = 'paused' | 'rate_limit' | 'invalid_pixel' | 'unauthorized';

export function createPixelMetrics(meter: Meter) {
  const processed = meter.createCounter('pixelwar.pixels.processed', { unit: '{pixel}', description: 'Pixels committed successfully' });
  const rejected = meter.createCounter('pixelwar.pixels.rejected', { unit: '{pixel}', description: 'Pixels rejected for an expected business reason' });
  const latency = meter.createHistogram('pixelwar.draw.end_to_end', { unit: 's', description: 'Event creation to successful pixel commit' });

  function validateCount(count: number): void {
    if (!Number.isSafeInteger(count) || count < 0) throw new Error('Pixel count must be a non-negative safe integer');
  }

  return {
    processed(count: number, source: PixelSource): void {
      validateCount(count);
      if (!['web', 'discord'].includes(source)) throw new Error('Unknown pixel source');
      processed.add(count, { source });
    },
    rejected(count: number, source: PixelSource, reason: RejectionReason): void {
      validateCount(count);
      if (!['web', 'discord'].includes(source)) throw new Error('Unknown pixel source');
      if (!['paused', 'rate_limit', 'invalid_pixel', 'unauthorized'].includes(reason)) throw new Error('Unknown rejection reason');
      rejected.add(count, { source, reason });
    },
    latency(occurredAt: string, committedAt = Date.now()): void {
      const duration = committedAt - Date.parse(occurredAt);
      if (!Number.isFinite(duration) || duration < 0) throw new Error('Invalid event timing');
      latency.record(duration / 1000);
    },
  };
}

export type FunctionOutcome = 'published' | 'rejected' | 'updated' | 'expired' | 'skipped_web' | 'served' | 'error';
export type FunctionReason = 'none' | 'paused' | 'rate_limit' | 'out_of_bounds' | 'expired' | 'batch_budget_exceeded' |
  'unauthorized' | 'network' | 'http' | 'rate_limited' | 'invalid_clock' | 'publish' | 'processing';
export interface DrawObservation {
  source: PixelSource;
  type: 'pixel-processed' | 'pixel-rejected';
  reason?: string;
  requested_pixels: number;
  applied_pixels: number;
  ignored_pixels: number;
  occurred_at: string;
  processed_at: string;
}
const outcomes = ['published', 'rejected', 'updated', 'expired', 'skipped_web', 'served', 'error'];
const reasons = ['none', 'paused', 'rate_limit', 'out_of_bounds', 'expired', 'batch_budget_exceeded', 'unauthorized', 'network', 'http', 'rate_limited', 'invalid_clock', 'publish', 'processing'];

/** Attempt/result observations, deliberately NOT an exactly-once accounting ledger. */
export function createFunctionMetrics(meter: Meter) {
  const attempts = meter.createCounter('pixelwar.function.attempts', { unit: '{attempt}', description: 'Validated processing attempts, including redeliveries' });
  const duration = meter.createHistogram('pixelwar.function.duration', { unit: 's', description: 'Validated operation duration before telemetry flush' });
  const resultPixels = meter.createCounter('pixelwar.draw.result_pixels', { unit: '{pixel}', description: 'Pixels in observed results, including replayed results' });
  const commitAge = meter.createHistogram('pixelwar.draw.result_age', { unit: 's', description: 'Stored commit time minus source creation time, observed on each result' });
  const notificationAge = meter.createHistogram('pixelwar.notification.age', { unit: 's', description: 'Interaction age at a notification attempt' });
  const labels = (source: PixelSource, outcome: FunctionOutcome, reason: FunctionReason) => {
    if (!['web', 'discord'].includes(source) || !outcomes.includes(outcome) || !reasons.includes(reason)) throw new Error('Invalid metric labels');
    return { source, outcome, reason };
  };
  return {
    attempt(source: PixelSource, outcome: FunctionOutcome, reason: FunctionReason, seconds: number) {
      const attributes = labels(source, outcome, reason);
      if (!Number.isFinite(seconds) || seconds < 0) throw new Error('Invalid operation duration');
      attempts.add(1, attributes); duration.record(seconds, attributes);
    },
    drawResult(result: DrawObservation) {
      const outcome = result.type === 'pixel-rejected' ? 'rejected' : 'published';
      const attributes = labels(result.source, outcome, (result.reason ?? 'none') as FunctionReason);
      const counts = { requested: result.requested_pixels, applied: result.applied_pixels, ignored: result.ignored_pixels };
      if (!['pixel-processed', 'pixel-rejected'].includes(result.type) || Object.values(counts).some((value) => !Number.isSafeInteger(value) || value < 0)) throw new Error('Invalid observed result');
      const age = Date.parse(result.processed_at) - Date.parse(result.occurred_at);
      if (!Number.isFinite(age)) throw new Error('Invalid observed result timing');
      for (const [category, count] of Object.entries(counts)) resultPixels.add(count, { ...attributes, category });
      commitAge.record(Math.max(0, age) / 1000, attributes);
    },
    notificationAge(seconds: number) {
      if (!Number.isFinite(seconds) || seconds < 0) throw new Error('Invalid notification age');
      notificationAge.record(seconds);
    },
  };
}
