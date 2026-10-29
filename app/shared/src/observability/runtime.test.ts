import { afterEach, describe, expect, it } from 'vitest';
import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace';
import { AggregationTemporality, InMemoryMetricExporter, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { createObservability, type ObservabilityOptions } from './index';

const instances: ReturnType<typeof createObservability>[] = [];
const defaults: ObservabilityOptions = { serviceName: 'test', projectId: 'demo-test', environment: 'dev', region: 'europe-west1' };
function runtime(options: Partial<ObservabilityOptions> = {}) {
  const instance = createObservability({ ...defaults, ...options });
  instances.push(instance);
  return instance;
}
afterEach(async () => { await Promise.all(instances.splice(0).map((instance) => instance.shutdown())); });

describe('observed operations', () => {
  it('keeps one trace and correlation through proxy, worker and downstream publication', async () => {
    const exporter = new InMemorySpanExporter();
    const lines: string[] = [];
    const proxy = runtime({ serviceName: 'web-proxy', serviceVersion: 'v1', spanExporter: exporter });
    const worker = runtime({ serviceName: 'draw-worker', spanExporter: exporter, writeLog: (line) => lines.push(line) });
    let requestId = '';
    const result = await proxy.request('POST /api/pixels', {}, async ({ correlationId }) => {
      requestId = correlationId;
      const attributes = proxy.attributes();
      return worker.message('pixel-draw', attributes, async ({ correlationId: workerId }) => {
        expect(workerId).toBe(requestId);
        await Promise.resolve();
        worker.log('INFO', 'Pixels committed', { event_type: 'pixel-draw', user_id: '123' });
        expect(worker.attributes().correlation_id).toBe(requestId);
        return 'accepted';
      });
    });
    expect(result).toBe('accepted');
    await proxy.flush();
    await worker.flush();
    const spans = exporter.getFinishedSpans();
    const server = spans.find((span) => span.kind === SpanKind.SERVER)!;
    const consumer = spans.find((span) => span.kind === SpanKind.CONSUMER)!;
    expect(consumer.spanContext().traceId).toBe(server.spanContext().traceId);
    expect(consumer.parentSpanContext?.spanId).toBe(server.spanContext().spanId);
    expect(consumer.attributes.correlation_id).toBe(requestId);
    expect(JSON.parse(lines[0])['logging.googleapis.com/trace']).toContain(server.spanContext().traceId);
    expect(() => worker.attributes()).toThrow();
  });

  it('isolates concurrent messages across async operations', async () => {
    const lines: string[] = [];
    const obs = runtime({ writeLog: (line) => lines.push(line) });
    await Promise.all(['first', 'second'].map((id) => obs.message('pixel-draw', { correlation_id: id }, async () => {
      await new Promise((resolve) => setTimeout(resolve, id === 'first' ? 10 : 1));
      obs.log('INFO', id);
      expect(obs.attributes().correlation_id).toBe(id);
    })));
    for (const line of lines) {
      const record = JSON.parse(line);
      expect(record.correlation_id).toBe(record.message);
    }
  });

  it('marks technical errors and ends spans without leaking the error payload', async () => {
    const exporter = new InMemorySpanExporter();
    const lines: string[] = [];
    const obs = runtime({ spanExporter: exporter, writeLog: (line) => lines.push(line) });
    const error = new Error('secret-token=do-not-log');
    await expect(obs.message('pixel-draw', {}, async () => { throw error; })).rejects.toBe(error);
    await obs.flush();
    const span = exporter.getFinishedSpans()[0];
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.events[0].name).toBe('operation.failed');
    expect(JSON.stringify(span.events) + lines.join('')).not.toContain('do-not-log');
    expect(JSON.parse(lines[0])).toMatchObject({ severity: 'ERROR', event_type: 'pixel-draw' });
  });

  it('supports shutdown twice and rejects new operations afterwards', async () => {
    const obs = runtime({ samplingRatio: 0 });
    await obs.shutdown();
    await obs.shutdown();
    await expect(obs.request('closed', {}, async () => 1)).rejects.toThrow('shut down');
  });

  it.each([-1, 2, NaN])('rejects an invalid sampling ratio: %s', (samplingRatio) => {
    expect(() => createObservability({ ...defaults, samplingRatio })).toThrow('Sampling');
  });
});

describe('business metrics', () => {
  it('exports pixel counts, bounded reasons and latency in seconds', async () => {
    const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const obs = runtime({ metricReader: new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 60_000 }) });
    obs.pixels.processed(3, 'web');
    obs.pixels.rejected(2, 'discord', 'paused');
    obs.pixels.latency('2026-10-29T10:00:00Z', Date.parse('2026-10-29T10:00:02Z'));
    await obs.flush();
    const metrics = exporter.getMetrics().flatMap((r) => r.scopeMetrics.flatMap((s) => s.metrics));
    const processed = metrics.find((m) => m.descriptor.name === 'pixelwar.pixels.processed')!;
    const rejected = metrics.find((m) => m.descriptor.name === 'pixelwar.pixels.rejected')!;
    const latency = metrics.find((m) => m.descriptor.name === 'pixelwar.draw.end_to_end')!;
    expect(processed.dataPoints[0].value).toBe(3);
    expect(rejected.dataPoints[0].attributes).toEqual({ source: 'discord', reason: 'paused' });
    expect(latency.dataPoints[0].value).toMatchObject({ sum: 2, count: 1 });
    expect(processed.dataPoints[0].attributes).not.toHaveProperty('user_id');
  });

  it('rejects invalid values instead of creating unbounded metric labels', () => {
    const obs = runtime();
    expect(() => obs.pixels.processed(-1, 'web')).toThrow();
    expect(() => obs.pixels.rejected(1.5, 'web', 'paused')).toThrow();
    // @ts-expect-error exercise runtime guard against untyped input
    expect(() => obs.pixels.processed(1, 'user-123')).toThrow();
    // @ts-expect-error exercise runtime guard against untyped input
    expect(() => obs.pixels.rejected(1, 'user-123', 'paused')).toThrow();
    // @ts-expect-error exercise runtime guard against untyped input
    expect(() => obs.pixels.rejected(1, 'web', 'secret-user-id')).toThrow();
    expect(() => obs.pixels.latency('not-a-date')).toThrow();
    expect(() => obs.pixels.latency('2026-10-29T10:00:00Z', 0)).toThrow();
    expect(() => obs.pixels.latency(new Date(Date.now() - 1000).toISOString())).not.toThrow();
  });
});
