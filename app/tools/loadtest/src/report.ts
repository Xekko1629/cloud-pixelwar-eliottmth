import { resultEventId } from '../../../functions/draw-worker/src/result';
import type { RunRecord } from './send';

/** One entry of `gcloud logging read --format=json`; only the fields used here. */
export interface LogEntry {
  timestamp?: string;
  jsonPayload?: { event_type?: unknown; event_id?: unknown; result_type?: unknown };
}

export interface RunReport {
  started_at: string;
  strokes: { sent: number; accepted: number; refused: Record<string, number>; max_response_ms: number };
  pixels: { accepted: number; processed: number; rejected: number; missing: number; redelivered: number };
  first_processed_at: string | null;
  last_processed_at: string | null;
  /** From the first request to the last processed pixel: what a user waits for. */
  drain_seconds: number | null;
  /** Processed pixels divided by drain_seconds (cold start included). */
  pixels_per_second: number | null;
  /** Between the first and the last processed pixel: the rate once the workers run. */
  steady_pixels_per_second: number | null;
  /** Per pixel, from the sending of its stroke to its processing. */
  latency_seconds: { p50: number; p95: number; max: number } | null;
}

const round = (value: number, digits = 2) => Math.round(value * 10 ** digits) / 10 ** digits;
const quantile = (sorted: number[], q: number) => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];

export function summarize(run: RunRecord, entries: LogEntry[]): RunReport {
  // The draw-worker logs the id of the RESULT event, derived from the command id.
  const sentAt = new Map<string, number>();
  for (const stroke of run.results) for (const id of stroke.event_ids) sentAt.set(resultEventId(id), Date.parse(stroke.sent_at));

  // The first log of an event is its processing; later ones are Pub/Sub redeliveries.
  const processed = new Map<string, { at: number; type: string }>();
  let redelivered = 0;
  for (const entry of entries) {
    const payload = entry.jsonPayload;
    const at = Date.parse(entry.timestamp ?? '');
    if (payload?.event_type !== 'draw.result.published' || typeof payload.event_id !== 'string') continue;
    if (!sentAt.has(payload.event_id) || Number.isNaN(at)) continue;
    const previous = processed.get(payload.event_id);
    if (previous) { redelivered++; if (at >= previous.at) continue; }
    processed.set(payload.event_id, { at, type: String(payload.result_type) });
  }

  const refused: Record<string, number> = {};
  for (const stroke of run.results) {
    if (stroke.status !== 202) refused[stroke.error ?? 'unknown'] = (refused[stroke.error ?? 'unknown'] ?? 0) + 1;
  }
  const times = [...processed.values()].map((p) => p.at).sort((a, b) => a - b);
  const latencies = [...processed].map(([id, p]) => (p.at - sentAt.get(id)!) / 1000).sort((a, b) => a - b);
  const started = Date.parse(run.started_at);
  const first = times[0];
  const last = times.at(-1);
  const drain = last === undefined ? null : (last - started) / 1000;
  return {
    started_at: run.started_at,
    strokes: {
      sent: run.results.length, accepted: run.results.filter((s) => s.status === 202).length, refused,
      max_response_ms: Math.max(0, ...run.results.map((s) => s.duration_ms)),
    },
    pixels: {
      accepted: sentAt.size, processed: processed.size,
      rejected: [...processed.values()].filter((p) => p.type === 'pixel-rejected').length,
      missing: sentAt.size - processed.size, redelivered,
    },
    first_processed_at: first === undefined ? null : new Date(first).toISOString(),
    last_processed_at: last === undefined ? null : new Date(last).toISOString(),
    drain_seconds: drain === null ? null : round(drain),
    pixels_per_second: drain ? round(processed.size / drain) : null,
    steady_pixels_per_second: times.length > 1 && last! > first! ? round((times.length - 1) / ((last! - first!) / 1000)) : null,
    latency_seconds: latencies.length
      ? { p50: round(quantile(latencies, 0.5)), p95: round(quantile(latencies, 0.95)), max: round(latencies.at(-1)!) }
      : null,
  };
}

/** Logging filter for the run: the draw-worker results written since its first request. */
export function logFilter(run: RunRecord): string {
  return [
    'resource.type="cloud_run_revision"', 'resource.labels.service_name="draw-worker"',
    'jsonPayload.event_type="draw.result.published"', `timestamp>="${run.started_at}"`,
  ].join(' AND ');
}
