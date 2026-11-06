import { randomUUID } from 'node:crypto';
import { ROOT_CONTEXT, createContextKey, defaultTextMapGetter, defaultTextMapSetter, type Context } from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';

export type TraceCarrier = Record<string, string | undefined>;
export const correlationKey = createContextKey('pixelwar.correlation_id');
const propagator = new W3CTraceContextPropagator();

export function newCorrelationId(): string {
  return randomUUID();
}

export function extractMessageContext(carrier: TraceCarrier): Context {
  const candidate = carrier.correlation_id;
  const correlationId = candidate && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(candidate)
    ? candidate : newCorrelationId();
  // Extract from ROOT, never from another concurrently processed message.
  return propagator.extract(ROOT_CONTEXT, carrier, defaultTextMapGetter)
    .setValue(correlationKey, correlationId);
}

export function extractRequestContext(carrier: TraceCarrier = {}): Context {
  // A public request gets our own correlation ID, not an untrusted client value.
  return propagator.extract(ROOT_CONTEXT, carrier, defaultTextMapGetter)
    .setValue(correlationKey, newCorrelationId());
}

export function injectMessageContext(active: Context): Record<string, string> {
  const attributes: Record<string, string> = {};
  propagator.inject(active, attributes, defaultTextMapSetter);
  const correlationId = active.getValue(correlationKey);
  if (typeof correlationId !== 'string' || !attributes.traceparent) {
    throw new Error('Publish inside an observed request or message span');
  }
  attributes.correlation_id = correlationId;
  return attributes;
}
