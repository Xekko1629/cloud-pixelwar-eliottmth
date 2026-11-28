// Same shape as ExportResult of @opentelemetry/core; 0 is ExportResultCode.SUCCESS.
interface ExportResult { code: number; error?: Error }

export type TelemetrySignal = 'traces' | 'metrics';
export type ExportFailureListener = (signal: TelemetrySignal, reason: string) => void;

/** http_<status> (OTLP exporter error), timeout, or other: never the message, which may carry a body. */
export function exportFailureReason(error: unknown): string {
  const { code, message } = (error ?? {}) as { code?: unknown; message?: unknown };
  if (typeof code === 'number' && Number.isInteger(code) && code >= 100 && code <= 599) return `http_${code}`;
  if (typeof message === 'string' && /time ?out/i.test(message)) return 'timeout';
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
