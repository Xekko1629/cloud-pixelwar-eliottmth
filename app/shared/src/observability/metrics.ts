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
