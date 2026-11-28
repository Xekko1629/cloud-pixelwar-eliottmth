import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getClient: vi.fn(), getRequestHeaders: vi.fn(), auth: vi.fn(),
  traces: vi.fn(), metricExporter: vi.fn(), reader: vi.fn(), runtime: vi.fn(),
}));
vi.mock('google-auth-library', () => ({ GoogleAuth: class {
  constructor(options: unknown) { mocks.auth(options); }
  getClient() { return mocks.getClient(); }
} }));
type Done = (result: { code: number; error?: unknown }) => void;
vi.mock('@opentelemetry/exporter-trace-otlp-proto', () => ({ OTLPTraceExporter: class {
  constructor(options: unknown) { mocks.traces(options); }
  export(_spans: unknown, done: Done) { done({ code: 1, error: { code: 400, message: 'synthetic-body' } }); }
} }));
vi.mock('@opentelemetry/exporter-metrics-otlp-proto', () => ({ OTLPMetricExporter: class {
  constructor(options: unknown) { mocks.metricExporter(options); }
  export(_metrics: unknown, done: Done) { done({ code: 1, error: new Error('Timeout') }); }
} }));
vi.mock('@opentelemetry/sdk-metrics', () => ({ PeriodicExportingMetricReader: class {
  constructor(options: unknown) { mocks.reader(options); }
} }));
vi.mock('./runtime', () => ({ createObservability: mocks.runtime }));

import { createGoogleObservability } from './google';
const options = { serviceName: 'draw-worker', projectId: 'demo-test', environment: 'dev' as const, region: 'europe-west1' };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.getClient.mockResolvedValue({ getRequestHeaders: mocks.getRequestHeaders });
});

it('configures standard OTLP with refreshing ADC credentials and bounded metric batches', async () => {
  await createGoogleObservability(options);
  expect(mocks.auth).toHaveBeenCalledWith({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  expect(mocks.traces.mock.calls[0][0].url).toBe('https://telemetry.googleapis.com/v1/traces');
  expect(mocks.metricExporter.mock.calls[0][0].url).toBe('https://telemetry.googleapis.com/v1/metrics');
  expect(mocks.reader.mock.calls[0][0]).toMatchObject({ maxExportBatchSize: 200, exportIntervalMillis: 60_000 });
  expect(mocks.runtime.mock.calls[0][0]).toMatchObject(options);
  const headers = mocks.traces.mock.calls[0][0].headers;
  mocks.getRequestHeaders.mockResolvedValueOnce(new Headers({ authorization: 'Bearer first' }));
  expect(await headers()).toEqual({ authorization: 'Bearer first' });
  mocks.getRequestHeaders.mockResolvedValueOnce(new Headers({ authorization: 'Bearer refreshed' }));
  expect(await headers()).toEqual({ authorization: 'Bearer refreshed' });
  expect(mocks.metricExporter.mock.calls[0][0].headers).toBe(headers);
});

it('reports ADC startup failure without silently claiming telemetry is enabled', async () => {
  mocks.getClient.mockRejectedValueOnce(new Error('ADC unavailable'));
  await expect(createGoogleObservability(options)).rejects.toThrow('ADC unavailable');
  expect(mocks.runtime).not.toHaveBeenCalled();
});

it('applies the configured export budget to both HTTP exporters and the SDK reader', async () => {
  await createGoogleObservability({ ...options, exportTimeoutMillis: 500 });
  expect(mocks.traces.mock.calls[0][0].timeoutMillis).toBe(500);
  expect(mocks.metricExporter.mock.calls[0][0].timeoutMillis).toBe(500);
  expect(mocks.reader.mock.calls[0][0].exportTimeoutMillis).toBe(1500);
});

it('reports the signal and bounded reason of each failed export, when asked to', async () => {
  const onExportFailure = vi.fn();
  await createGoogleObservability({ ...options, onExportFailure });
  const runtime = mocks.runtime.mock.calls[0][0];
  expect(runtime).not.toHaveProperty('onExportFailure');
  runtime.spanExporter.export([], () => undefined);
  mocks.reader.mock.calls[0][0].exporter.export([], () => undefined);
  expect(onExportFailure.mock.calls).toEqual([['traces', 'http_400'], ['metrics', 'timeout']]);
});
