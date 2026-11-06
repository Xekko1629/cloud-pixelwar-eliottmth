import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getClient: vi.fn(), getRequestHeaders: vi.fn(), auth: vi.fn(),
  traces: vi.fn(), metricExporter: vi.fn(), reader: vi.fn(), runtime: vi.fn(),
}));
vi.mock('google-auth-library', () => ({ GoogleAuth: class {
  constructor(options: unknown) { mocks.auth(options); }
  getClient() { return mocks.getClient(); }
} }));
vi.mock('@opentelemetry/exporter-trace-otlp-proto', () => ({ OTLPTraceExporter: class {
  constructor(options: unknown) { mocks.traces(options); }
} }));
vi.mock('@opentelemetry/exporter-metrics-otlp-proto', () => ({ OTLPMetricExporter: class {
  constructor(options: unknown) { mocks.metricExporter(options); }
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
