import { InMemorySpanExporter } from '@opentelemetry/sdk-trace';
import { AggregationTemporality, InMemoryMetricExporter, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { createObservability } from '../src/observability/runtime';
import { createFunctionTelemetry } from '../src/observability/function';

/** Test-only providers; no ADC, remote endpoint or global OpenTelemetry registration. */
export function memoryTelemetry(service: Parameters<typeof createFunctionTelemetry>[0], writeLog: (line: string) => void, now = Date.now) {
  const spans = new InMemorySpanExporter();
  const metrics = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const runtime = createObservability({ serviceName: service, projectId: 'demo-pixelwar-test', environment: 'dev', region: 'europe-west1',
    spanExporter: spans, metricReader: new PeriodicExportingMetricReader({ exporter: metrics, exportIntervalMillis: 60_000 }), writeLog });
  return { spans, metrics, runtime, telemetry: createFunctionTelemetry(service, { getRuntime: () => runtime, writeLog, now }) };
}
