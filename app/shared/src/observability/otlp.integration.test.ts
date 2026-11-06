import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { expect, it } from 'vitest';
import { createObservability } from './runtime';

it('sends trace and metric protobuf batches to a local OTLP HTTP receiver', async () => {
  const requests: { path: string; contentType: string; bytes: number }[] = [];
  const server = createServer((request, response) => {
    let bytes = 0;
    request.on('data', (chunk: Buffer) => { bytes += chunk.length; });
    request.on('end', () => {
      requests.push({ path: request.url!, contentType: String(request.headers['content-type']), bytes });
      response.writeHead(200, { 'content-type': 'application/x-protobuf' });
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const obs = createObservability({
    serviceName: 'test-worker', projectId: 'demo-pixelwar-test', environment: 'dev', region: 'europe-west1',
    spanExporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces`, timeoutMillis: 2000 }),
    metricReader: new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter({ url: `${endpoint}/v1/metrics`, timeoutMillis: 2000 }),
      exportIntervalMillis: 60_000, maxExportBatchSize: 200,
    }),
  });
  try {
    await obs.message('pixel-draw', {}, async () => {
      obs.pixels.processed(1, 'web');
    });
    await obs.flush();
    expect(requests.map((request) => request.path)).toContain('/v1/traces');
    expect(requests.map((request) => request.path)).toContain('/v1/metrics');
    expect(requests.every((request) => request.bytes > 0 && request.contentType === 'application/x-protobuf')).toBe(true);
  } finally {
    await obs.shutdown();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
