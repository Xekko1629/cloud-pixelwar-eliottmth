import { ROOT_CONTEXT, trace, TraceFlags } from '@opentelemetry/api';
import { describe, expect, it } from 'vitest';
import { correlationKey, extractMessageContext, extractRequestContext, injectMessageContext } from './context';

const traceparent = '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01';

describe('W3C context and correlation', () => {
  it('continues a valid remote trace and creates its own HTTP correlation ID', () => {
    const active = extractRequestContext({ traceparent, correlation_id: 'client-controlled' });
    expect(trace.getSpanContext(active)?.traceId).toBe('0123456789abcdef0123456789abcdef');
    expect(active.getValue(correlationKey)).not.toBe('client-controlled');
    expect(active.getValue(correlationKey)).toMatch(/^[a-f0-9-]{36}$/);
  });

  it('creates a context for a request with no headers', () => {
    expect(extractRequestContext().getValue(correlationKey)).toBeTypeOf('string');
  });

  it('keeps the internal correlation ID and injects only trace context', () => {
    const active = extractMessageContext({ traceparent, correlation_id: 'internal-123', baggage: 'token=secret' });
    const output = injectMessageContext(active);
    expect(output).toEqual({ traceparent, correlation_id: 'internal-123' });
    expect(output).not.toHaveProperty('baggage');
  });

  it.each([undefined, '', 'bad\nvalue', 'x'.repeat(129)])('replaces an invalid correlation ID: %s', (correlation_id) => {
    const active = extractMessageContext({ correlation_id, traceparent: 'malformed' });
    expect(active.getValue(correlationKey)).toMatch(/^[a-f0-9-]{36}$/);
    expect(trace.getSpanContext(active)).toBeUndefined();
  });

  it('refuses publication outside an observed operation', () => {
    expect(() => injectMessageContext(ROOT_CONTEXT)).toThrow();
    const noCorrelation = trace.setSpanContext(ROOT_CONTEXT, {
      traceId: '0123456789abcdef0123456789abcdef', spanId: '0123456789abcdef', traceFlags: TraceFlags.SAMPLED,
    });
    expect(() => injectMessageContext(noCorrelation)).toThrow();
  });
});
