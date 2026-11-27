import { describe, expect, it } from 'vitest';
import { resultEventId } from '../../../functions/draw-worker/src/result';
import { logFilter, summarize, type LogEntry } from './report';
import type { RunRecord } from './send';

const run: RunRecord = {
  schema_version: 1, started_at: '2026-11-26T15:00:00.000Z', finished_at: '2026-11-26T15:00:01.000Z',
  strokes: 3, pixels_per_stroke: 2, origin: { x: 0, y: 0 },
  results: [
    { index: 0, status: 202, sent_at: '2026-11-26T15:00:00.000Z', duration_ms: 400, event_ids: ['a', 'b'] },
    { index: 1, status: 202, sent_at: '2026-11-26T15:00:01.000Z', duration_ms: 900, event_ids: ['c', 'd'] },
    { index: 2, status: 429, sent_at: '2026-11-26T15:00:00.000Z', duration_ms: 50, event_ids: [], error: 'rate_limited' },
  ],
};
const log = (id: string, second: number, type = 'pixel-processed'): LogEntry => ({
  timestamp: `2026-11-26T15:00:${String(second).padStart(2, '0')}.000Z`,
  // The draw-worker logs the result event id, not the command id returned by the web-proxy.
  jsonPayload: { event_type: 'draw.result.published', event_id: resultEventId(id), result_type: type },
});

describe('summarize', () => {
  it('measures drain time, rates and per-pixel latency of the run', () => {
    const report = summarize(run, [
      log('d', 10), log('a', 2), log('b', 4), log('c', 6, 'pixel-rejected'), log('b', 9), // b redelivered
      log('other', 3), { timestamp: 'bad', jsonPayload: { event_type: 'draw.result.published', event_id: resultEventId('a') } },
      { timestamp: '2026-11-26T15:00:01.000Z', jsonPayload: { event_type: 'draw.result.published', event_id: 'a' } },
      { jsonPayload: { event_type: 'draw.message.invalid' } },
    ]);
    expect(report).toEqual({
      started_at: run.started_at,
      strokes: { sent: 3, accepted: 2, refused: { rate_limited: 1 }, max_response_ms: 900 },
      pixels: { accepted: 4, processed: 4, rejected: 1, missing: 0, redelivered: 1 },
      first_processed_at: '2026-11-26T15:00:02.000Z', last_processed_at: '2026-11-26T15:00:10.000Z',
      drain_seconds: 10, pixels_per_second: 0.4, steady_pixels_per_second: 0.38,
      latency_seconds: { p50: 4, p95: 9, max: 9 },
    });
  });
  it('keeps the earliest log when a redelivery is listed first', () => {
    const report = summarize(run, [log('a', 8), log('a', 3)]);
    expect(report.first_processed_at).toBe('2026-11-26T15:00:03.000Z');
    expect(report.pixels).toMatchObject({ processed: 1, missing: 3, redelivered: 1 });
    expect(report.steady_pixels_per_second).toBeNull();
  });
  it('reports a run that nothing processed yet', () => {
    expect(summarize(run, [])).toMatchObject({
      pixels: { processed: 0, missing: 4 }, drain_seconds: null, pixels_per_second: null, latency_seconds: null,
    });
  });
});

describe('logFilter', () => {
  it('selects the draw-worker results written since the run started', () => {
    expect(logFilter(run)).toBe('resource.type="cloud_run_revision" AND resource.labels.service_name="draw-worker"'
      + ' AND jsonPayload.event_type="draw.result.published" AND timestamp>="2026-11-26T15:00:00.000Z"');
  });
});
