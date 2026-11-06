import { randomUUID } from 'node:crypto';
import { trace, SpanKind, SpanStatusCode, type Context, type Span } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { MeterProvider, type IMetricReader } from '@opentelemetry/sdk-metrics';
import { TracerProvider, BatchSpanProcessor, ParentBasedSampler, TraceIdRatioBasedSampler, type SpanExporter } from '@opentelemetry/sdk-trace';
import { correlationKey, extractMessageContext, extractRequestContext, injectMessageContext, type TraceCarrier } from './context';
import { createLogger, type LogFields } from './logger';
import { createPixelMetrics } from './metrics';

export interface ObservabilityOptions {
  serviceName: string;
  projectId: string;
  environment: 'dev' | 'prd';
  region: string;
  serviceVersion?: string;
  samplingRatio?: number;
  spanExporter?: SpanExporter;
  metricReader?: IMetricReader;
  writeLog?: (line: string) => void;
}

export function createObservability(options: ObservabilityOptions) {
  const ratio = options.samplingRatio ?? 1;
  if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1) throw new Error('Sampling ratio must be between 0 and 1');
  const resource = resourceFromAttributes({
    'service.name': options.serviceName,
    'service.version': options.serviceVersion ?? 'development',
    'service.instance.id': randomUUID(),
    'deployment.environment.name': options.environment,
    'gcp.project_id': options.projectId,
    'cloud.provider': 'gcp',
    'cloud.region': options.region,
  });
  const contextManager = new AsyncLocalStorageContextManager().enable();
  const traces = new TracerProvider({
    resource,
    sampler: new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(ratio) }),
    spanProcessors: options.spanExporter ? [new BatchSpanProcessor({ exporter: options.spanExporter, exportTimeoutMillis: 2000 })] : [],
  });
  const metrics = new MeterProvider({ resource, readers: options.metricReader ? [options.metricReader] : [] });
  const tracer = traces.getTracer('pixelwar');
  const log = createLogger({
    serviceName: options.serviceName,
    projectId: options.projectId,
    activeContext: () => contextManager.active(),
    write: options.writeLog,
  });
  let closed = false;

  async function observed<T>(name: string, kind: SpanKind, parent: Context, fields: LogFields, work: (operation: { correlationId: string; span: Span }) => Promise<T>): Promise<T> {
    if (closed) throw new Error('Observability has been shut down');
    const correlationId = parent.getValue(correlationKey) as string;
    const span = tracer.startSpan(name, { kind, attributes: { correlation_id: correlationId } }, parent);
    return contextManager.with(trace.setSpan(parent, span), async () => {
      try {
        return await work({ correlationId, span });
      } catch (error) {
        // Error messages/stacks may contain tokens or payloads; record only a safe marker.
        span.setStatus({ code: SpanStatusCode.ERROR, message: 'Operation failed' });
        span.addEvent('operation.failed');
        log('ERROR', 'Operation failed', fields);
        throw error;
      } finally {
        span.end();
      }
    });
  }

  return {
    log,
    pixels: createPixelMetrics(metrics.getMeter('pixelwar')),
    request<T>(name: string, headers: TraceCarrier, work: (operation: { correlationId: string; span: Span }) => Promise<T>): Promise<T> {
      return observed(name, SpanKind.SERVER, extractRequestContext(headers), {}, work);
    },
    message<T>(eventType: string, attributes: TraceCarrier, work: (operation: { correlationId: string; span: Span }) => Promise<T>): Promise<T> {
      return observed(eventType, SpanKind.CONSUMER, extractMessageContext(attributes), { event_type: eventType }, work);
    },
    attributes(): Record<string, string> {
      return injectMessageContext(contextManager.active());
    },
    async flush(): Promise<void> {
      await Promise.all([traces.forceFlush(), metrics.forceFlush()]);
    },
    async shutdown(): Promise<void> {
      if (closed) return;
      closed = true;
      try {
        await Promise.all([traces.shutdown(), metrics.shutdown()]);
      } finally {
        contextManager.disable();
      }
    },
  };
}
