import { GoogleAuth } from 'google-auth-library';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { createObservability, type ObservabilityOptions } from './runtime';
import { observeExportFailures, type ExportFailureListener } from './export-error';

// No ADC lookup or network call on import. Invoke once at application startup.
export async function createGoogleObservability(
  { onExportFailure, ...options }: Omit<ObservabilityOptions, 'spanExporter' | 'metricReader'> & { onExportFailure?: ExportFailureListener },
) {
  const timeout = options.exportTimeoutMillis ?? 2000;
  const client = await new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] }).getClient();
  const headers = async (): Promise<Record<string, string>> => {
    const result: Record<string, string> = {};
    (await client.getRequestHeaders()).forEach((value, key) => { result[key] = value; });
    return result;
  };

  const observe = <T extends Parameters<typeof observeExportFailures>[0]>(exporter: T, signal: 'traces' | 'metrics'): T =>
    onExportFailure ? observeExportFailures(exporter, signal, onExportFailure) : exporter;

  return createObservability({
    ...options,
    spanExporter: observe(new OTLPTraceExporter({
      url: 'https://telemetry.googleapis.com/v1/traces', headers, timeoutMillis: timeout,
    }), 'traces'),
    metricReader: new PeriodicExportingMetricReader({
      exporter: observe(new OTLPMetricExporter({
        url: 'https://telemetry.googleapis.com/v1/metrics', headers, timeoutMillis: timeout,
      }), 'metrics'),
      exportIntervalMillis: 60_000,
      exportTimeoutMillis: timeout + 1000,
      maxExportBatchSize: 200,
    }),
  });
}
