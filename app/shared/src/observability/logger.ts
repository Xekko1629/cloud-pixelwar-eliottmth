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

export function createLogger(options: LoggerOptions) {
  const write = options.write ?? ((line: string) => { process.stdout.write(line); });

  return (severity: Severity, message: string, fields: LogFields = {}): void => {
    const active = options.activeContext?.() ?? ROOT_CONTEXT;
    const span = trace.getSpanContext(active);
    const record: Record<string, unknown> = {
      timestamp: new Date().toISOString(),
      severity,
      message,
      function: options.serviceName,
      event_type: fields.event_type ?? null,
      correlation_id: active.getValue(correlationKey) ?? null,
      user_id: fields.user_id ?? null,
    };
    if (span && isSpanContextValid(span)) {
      record['logging.googleapis.com/trace'] = `projects/${options.projectId}/traces/${span.traceId}`;
      record['logging.googleapis.com/spanId'] = span.spanId;
      record['logging.googleapis.com/trace_sampled'] = Boolean(span.traceFlags & TraceFlags.SAMPLED);
    }
    // Only known fields: never spread a request, message, token or Error object.
    write(`${JSON.stringify(record)}\n`);
  };
}
