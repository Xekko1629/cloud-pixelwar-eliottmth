// Same shape as ExportResult of @opentelemetry/core; 0 is ExportResultCode.SUCCESS.
interface ExportResult { code: number; error?: Error }

export type TelemetrySignal = 'traces' | 'metrics';
export type ExportFailureListener = (signal: TelemetrySignal, reason: string) => void;

/**
 * Fixed messages of @opentelemetry/otlp-exporter-base 0.300 (otlp-export-delegate,
 * http-transport-utils) that carry no HTTP status. They were all "other" on dev (28/11).
 */
const KNOWN_MESSAGES: readonly [RegExp, string][] = [
  // 429 or 5xx still failing after the exporter's own retries: the status itself is lost.
  [/^Export failed with retryable status$/, 'retryable_status'],
  // Too many exports in flight at once (flushes faster than the collector answers).
  [/^Concurren(t export|cy) limit reached$/i, 'concurrency_limit'], // delegate, bounded queue.
  [/^OTLP export response body exceeded size limit/, 'response_too_large'],
  [/^Nothing to send$/, 'nothing_to_send'],
];

/**
 * http_<status> (OTLP exporter error), timeout, a known message of the exporter, net_<code>
 * (Node network error such as ECONNRESET), or other. Never the message itself, which may
 * carry a response body.
 */
export function exportFailureReason(error: unknown): string {
  const { code, message } = (error ?? {}) as { code?: unknown; message?: unknown };
  if (typeof code === 'number' && Number.isInteger(code) && code >= 100 && code <= 599) return `http_${code}`;
  if (typeof code === 'string' && /^E[A-Z0-9_]{1,30}$/.test(code)) return `net_${code.toLowerCase()}`;
  if (typeof message === 'string') {
    if (/time(d)? ?out/i.test(message)) return 'timeout'; // "Request timed out": the Node transport.
    for (const [pattern, reason] of KNOWN_MESSAGES) if (pattern.test(message)) return reason;
  }
  return 'other';
}

/**
 * Reports each failed export of this exporter. The SDK does not: a failed span export never
 * rejects forceFlush (MultiSpanProcessor resolves anyway), and the metric reader turns the
 * exporter error into a plain message, losing its HTTP status.
 */
export function observeExportFailures<T extends { export(items: never, done: (result: ExportResult) => void): void }>(
  exporter: T, signal: TelemetrySignal, onFailure: ExportFailureListener,
): T {
  const original = exporter.export.bind(exporter) as (items: unknown, done: (result: ExportResult) => void) => void;
  (exporter as unknown as { export: (items: unknown, done: (result: ExportResult) => void) => void }).export = (items, done) => {
    original(items, (result) => {
      if (result.code !== 0) {
        try { onFailure(signal, exportFailureReason(result.error)); } catch { /* Observability never fails an export. */ }
      }
      done(result);
    });
  };
  return exporter;
}
