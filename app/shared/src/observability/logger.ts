import { ROOT_CONTEXT, trace, isSpanContextValid, TraceFlags, type Context } from '@opentelemetry/api';
import { correlationKey } from './context';

export type Severity = 'DEBUG' | 'INFO' | 'WARNING' | 'ERROR' | 'CRITICAL';
export interface LogFields {
  event_type?: string;
  user_id?: string;
}

export interface LoggerOptions {
  serviceName: string;
  projectId: string;
  activeContext?: () => Context;
  write?: (line: string) => void;
}

/** Safe context fields for an existing structured log; never carries baggage or payloads. */
export function logContextFields(active: Context, projectId: string): Record<string, string | boolean> {
  const fields: Record<string, string | boolean> = {};
  const correlation = active.getValue(correlationKey);
  if (typeof correlation === 'string') fields.correlation_id = correlation;
  const span = trace.getSpanContext(active);
  if (span && isSpanContextValid(span)) {
    fields['logging.googleapis.com/trace'] = `projects/${projectId}/traces/${span.traceId}`;
    fields['logging.googleapis.com/spanId'] = span.spanId;
    fields['logging.googleapis.com/trace_sampled'] = Boolean(span.traceFlags & TraceFlags.SAMPLED);
  }
  return fields;
}

export function createLogger(options: LoggerOptions) {
  const write = options.write ?? ((line: string) => { process.stdout.write(line); });

  return (severity: Severity, message: string, fields: LogFields = {}): void => {
    const active = options.activeContext?.() ?? ROOT_CONTEXT;
    const record: Record<string, unknown> = {
      timestamp: new Date().toISOString(),
      severity,
      message,
      function: options.serviceName,
      event_type: fields.event_type ?? null,
      correlation_id: active.getValue(correlationKey) ?? null,
      user_id: fields.user_id ?? null,
    };
    Object.assign(record, logContextFields(active, options.projectId));
    // Only known fields: never spread a request, message, token or Error object.
    write(`${JSON.stringify(record)}\n`);
  };
}
