import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ google: vi.fn() }));
vi.mock('./google', () => ({ createGoogleObservability: mocks.google }));
import { memoryTelemetry } from '../../testing/telemetry';
import { createFunctionTelemetry } from './function';

const instances: ReturnType<typeof memoryTelemetry>[] = [];
const attributes = { correlation_id: 'test-correlation', traceparent: `00-${'1'.repeat(32)}-${'2'.repeat(16)}-01` };
beforeEach(() => {
  vi.clearAllMocks(); vi.stubEnv('NODE_ENV', 'production'); vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'demo-test');
  vi.stubEnv('APP_ENV', 'dev'); vi.stubEnv('FUNCTION_REGION', 'europe-west1'); vi.stubEnv('K_REVISION', 'test-revision');
});
afterEach(async () => { await Promise.all(instances.splice(0).map((instance) => instance.runtime.shutdown())); vi.unstubAllEnvs(); });
it('lazily selects the Google exporter in a configured runtime with a short export timeout', async () => {
  const instance = memoryTelemetry('discord-proxy', vi.fn()); instances.push(instance); mocks.google.mockResolvedValue(instance.runtime);
  const telemetry = createFunctionTelemetry('discord-proxy'); expect(mocks.google).not.toHaveBeenCalled();
  await telemetry.request('trusted-interaction', async (op) => { op.outcome('published'); });
  await telemetry.request('trusted-interaction', async (op) => { op.outcome('published'); });
  expect(mocks.google).toHaveBeenCalledTimes(1);
  expect(mocks.google.mock.calls[0][0]).toMatchObject({ projectId: 'demo-test', environment: 'dev', region: 'europe-west1', serviceVersion: 'test-revision', exportTimeoutMillis: 500 });
});
it('reports initialization failure without exposing ADC errors or failing the business operation', async () => {
  const write = vi.fn(); mocks.google.mockRejectedValue(new Error('synthetic-interaction-token'));
  const telemetry = createFunctionTelemetry('command-worker', { writeLog: write });
  expect(await telemetry.message('discord-command', attributes, async (op) => { op.outcome('published'); return 42; })).toBe(42);
  expect(JSON.stringify(write.mock.calls)).toContain('telemetry.initialization_failed');
  expect(JSON.stringify(write.mock.calls)).not.toContain('synthetic-interaction-token');
});
it('reports missing export configuration rather than claiming cloud telemetry was exported', async () => {
  vi.stubEnv('APP_ENV', undefined); vi.stubEnv('FUNCTION_REGION', undefined); vi.stubEnv('GOOGLE_CLOUD_REGION', undefined);
  const write = vi.fn(); const telemetry = createFunctionTelemetry('draw-worker', { writeLog: write });
  await telemetry.message('pixel-draw', attributes, async (op) => { op.outcome('published'); });
  expect(mocks.google).not.toHaveBeenCalled(); expect(JSON.stringify(write.mock.calls)).toContain('telemetry.export_not_configured');
});
it('does not export to Google without a region, which Cloud Monitoring would reject on every point', async () => {
  vi.stubEnv('FUNCTION_REGION', ''); vi.stubEnv('GOOGLE_CLOUD_REGION', undefined);
  const write = vi.fn(); const telemetry = createFunctionTelemetry('draw-worker', { writeLog: write });
  await telemetry.message('pixel-draw', attributes, async (op) => { op.outcome('published'); });
  await telemetry.message('pixel-draw', attributes, async (op) => { op.outcome('published'); });
  expect(mocks.google).not.toHaveBeenCalled();
  expect(write.mock.calls.filter(([line]) => String(line).includes('telemetry.export_not_configured'))).toHaveLength(1);
});
