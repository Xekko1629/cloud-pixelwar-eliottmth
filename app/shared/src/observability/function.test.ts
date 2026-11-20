import { afterEach, describe, expect, it, vi } from 'vitest';
import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { memoryTelemetry } from '../../testing/telemetry';
import { createFunctionTelemetry } from './function';

const instances: ReturnType<typeof memoryTelemetry>[] = [];
const make = (name: Parameters<typeof memoryTelemetry>[0] = 'draw-worker') => {
  const write = vi.fn(); const instance = memoryTelemetry(name, write, () => 10_000);
  instances.push(instance); return { ...instance, write };
};
afterEach(async () => { await Promise.all(instances.splice(0).map((instance) => instance.runtime.shutdown())); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
const attributes = { correlation_id: '11111111-1111-4111-8111-111111111111', traceparent: `00-${'1'.repeat(32)}-${'2'.repeat(16)}-01` };
const result = { source: 'discord' as const, type: 'pixel-processed' as const, requested_pixels: 1, applied_pixels: 1, ignored_pixels: 0,
  occurred_at: '2026-11-20T10:00:00.000Z', processed_at: '2026-11-20T10:00:02.000Z' };

describe('function instrumentation', () => {
  it('creates a trusted root and linked consumer span with safe context fields', async () => {
    const proxy = make('discord-proxy'); const worker = make();
    let propagated = attributes;
    await proxy.telemetry.request(attributes.correlation_id, async (op) => {
      propagated = op.attributes(); op.outcome('published'); op.log('INFO', 'Published.', 'command.published');
      expect(op.logFields().correlation_id).toBe(attributes.correlation_id);
    });
    await worker.telemetry.message('pixel-draw', propagated, async (op) => {
      op.source('web'); op.drawResult({ ...result, source: 'web' }); op.outcome('published');
      op.log('INFO', 'Committed.', 'draw.committed');
      expect(op.attributes().correlation_id).toBe(attributes.correlation_id);
    });
    const server = proxy.spans.getFinishedSpans()[0]; const consumer = worker.spans.getFinishedSpans()[0];
    expect(server.kind).toBe(SpanKind.SERVER); expect(consumer.kind).toBe(SpanKind.CONSUMER);
    expect(consumer.spanContext().traceId).toBe(server.spanContext().traceId);
    expect(consumer.parentSpanContext?.spanId).toBe(server.spanContext().spanId);
    expect(JSON.parse(worker.write.mock.calls[0][0])['logging.googleapis.com/trace']).toContain(server.spanContext().traceId);
  });
  it('records attempts/results again on retry without claiming unique committed pixels', async () => {
    const { telemetry, metrics } = make();
    for (let i = 0; i < 2; i++) await telemetry.message('pixel-draw', attributes, async (op) => { op.drawResult(result); op.outcome('published'); });
    const data = metrics.getMetrics().at(-1)!.scopeMetrics.flatMap((scope) => scope.metrics);
    const attempt = data.find((metric) => metric.descriptor.name === 'pixelwar.function.attempts')!;
    expect(attempt.dataPoints[0].value).toBe(2);
    const pixels = data.find((metric) => metric.descriptor.name === 'pixelwar.draw.result_pixels')!;
    expect(pixels.dataPoints.find((point) => point.attributes.category === 'applied')?.value).toBe(2);
    for (const metric of data) for (const point of metric.dataPoints) {
      expect(Object.keys(point.attributes).every((key) => ['source', 'outcome', 'reason', 'category'].includes(key))).toBe(true);
    }
  });
  it('records expiration, ages and technical errors without a token or URL in spans', async () => {
    const { telemetry, metrics, spans, write } = make('discord-notifier');
    await telemetry.message('pixel-processed', attributes, async (op) => { op.notificationAge(0); op.outcome('expired'); });
    const error = new Error('https://discord.com/webhooks/synthetic-interaction-token');
    await expect(telemetry.message('pixel-processed', attributes, async (op) => { op.outcome('error', 'network'); throw error; })).rejects.toBe(error);
    expect(spans.getFinishedSpans().at(-1)!.status.code).toBe(SpanStatusCode.ERROR);
    expect(JSON.stringify(spans.getFinishedSpans().map((span) => ({ name: span.name, attributes: span.attributes, events: span.events, status: span.status }))) + JSON.stringify(write.mock.calls)).not.toContain('synthetic-interaction-token');
    const data = metrics.getMetrics().at(-1)!.scopeMetrics.flatMap((scope) => scope.metrics);
    expect(data.find((metric) => metric.descriptor.name === 'pixelwar.notification.age')?.dataPoints[0].value).toMatchObject({ sum: 10, count: 1 });
  });
  it('awaits flush before returning and never replays successful work after export failure', async () => {
    const { telemetry, runtime, write } = make();
    let finish!: () => void;
    vi.spyOn(runtime, 'flush').mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const work = vi.fn(async (op) => { op.outcome('published'); return 'saved'; });
    let returned = false; const pending = telemetry.message('pixel-draw', attributes, work).then((value) => { returned = true; return value; });
    await vi.waitFor(() => expect(runtime.flush).toHaveBeenCalled()); expect(returned).toBe(false); finish();
    expect(await pending).toBe('saved');
    vi.spyOn(runtime, 'flush').mockRejectedValue(new Error('synthetic-interaction-token'));
    expect(await telemetry.message('pixel-draw', attributes, work)).toBe('saved'); expect(work).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(write.mock.calls)).toContain('telemetry.export_failed'); expect(JSON.stringify(write.mock.calls)).not.toContain('synthetic-interaction-token');
  });
  it('does not lose a business error if failure logging or export also fails', async () => {
    const { telemetry, runtime } = make(); const business = new Error('business failure');
    vi.spyOn(runtime, 'flush').mockRejectedValue(new Error('export failed'));
    await expect(telemetry.message('pixel-draw', attributes, async () => { throw business; })).rejects.toBe(business);
  });
  it('preserves business success if SDK wrapping fails before or after the callback', async () => {
    const { telemetry, runtime } = make();
    vi.spyOn(runtime, 'message').mockRejectedValueOnce(new Error('SDK unavailable'));
    const work = vi.fn(async () => 'saved');
    expect(await telemetry.message('pixel-draw', attributes, work)).toBe('saved'); expect(work).toHaveBeenCalledTimes(1);
    vi.spyOn(runtime, 'message').mockImplementationOnce(async (_name, _attrs, callback) => { await callback({ correlationId: attributes.correlation_id, span: undefined! }); throw new Error('SDK failed after work'); });
    expect(await telemetry.message('pixel-draw', attributes, work)).toBe('saved'); expect(work).toHaveBeenCalledTimes(2);
  });
  it('falls back to sanitized propagation if SDK initialization fails, without repeating initialization', async () => {
    const getRuntime = vi.fn().mockRejectedValue(new Error('synthetic-interaction-token'));
    const write = vi.fn(); const telemetry = createFunctionTelemetry('command-worker', { getRuntime, writeLog: write });
    for (let i = 0; i < 2; i++) await telemetry.message('discord-command', attributes, async (op) => {
      expect(op.attributes()).toEqual(attributes); expect(op.logFields()).toEqual({});
      op.log('INFO', 'Published.', 'command.published'); op.outcome('published');
      op.drawResult(result); op.notificationAge(0);
    });
    expect(getRuntime).toHaveBeenCalledTimes(1); expect(JSON.stringify(write.mock.calls)).not.toContain('synthetic-interaction-token');
  });
  it('makes attribute/metric/log failures non-fatal and never serializes their Errors', async () => {
    const { telemetry, runtime, write } = make();
    const error = new Error('synthetic-interaction-token');
    vi.spyOn(runtime, 'attributes').mockImplementation(() => { throw error; });
    vi.spyOn(runtime, 'logFields').mockImplementation(() => { throw error; });
    vi.spyOn(runtime, 'log').mockImplementation(() => { throw error; });
    vi.spyOn(runtime.functions, 'drawResult').mockImplementation(() => { throw error; });
    vi.spyOn(runtime.functions, 'notificationAge').mockImplementation(() => { throw error; });
    vi.spyOn(runtime.functions, 'attempt').mockImplementation(() => { throw error; });
    await telemetry.message('pixel-draw', attributes, async (op) => {
      expect(op.attributes()).toEqual(attributes); expect(op.logFields()).toEqual({}); op.log('INFO', 'Safe.', 'safe'); op.drawResult(result); op.notificationAge(0); op.outcome('published');
    });
    expect(JSON.stringify(write.mock.calls)).not.toContain('synthetic-interaction-token');
  });
  it('does not let a failed warning writer prevent business work', async () => {
    const telemetry = createFunctionTelemetry('draw-worker', { getRuntime: async () => { throw new Error(); }, writeLog: () => { throw new Error(); } });
    expect(await telemetry.message('pixel-draw', attributes, async (op) => { op.log('INFO', 'Safe.', 'safe'); return 1; })).toBe(1);
  });
  it('initializes a local runtime lazily without ADC in tests', async () => {
    const write = vi.fn(); const telemetry = createFunctionTelemetry('command-worker', { writeLog: write });
    expect(write).not.toHaveBeenCalled();
    await telemetry.message('discord-command', attributes, async (op) => { op.outcome('published'); });
  });
});
