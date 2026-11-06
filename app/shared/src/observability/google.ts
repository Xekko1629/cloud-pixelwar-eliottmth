import { GoogleAuth } from 'google-auth-library';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { createObservability, type ObservabilityOptions } from './runtime';

// No ADC lookup or network call on import. Invoke once at application startup.
export async function createGoogleObservability(
  options: Omit<ObservabilityOptions, 'spanExporter' | 'metricReader'>,
) {
  const client = await new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] }).getClient();
  const headers = async (): Promise<Record<string, string>> => {
    const result: Record<string, string> = {};
    (await client.getRequestHeaders()).forEach((value, key) => { result[key] = value; });
    return result;
  };

  return createObservability({
    ...options,
    spanExporter: new OTLPTraceExporter({
      url: 'https://telemetry.googleapis.com/v1/traces', headers, timeoutMillis: 2000,
    }),
    metricReader: new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter({
        url: 'https://telemetry.googleapis.com/v1/metrics', headers, timeoutMillis: 2000,
      }),
      exportIntervalMillis: 60_000,
      exportTimeoutMillis: 3000,
      maxExportBatchSize: 200,
    }),
  });
}
