import { ROOT_CONTEXT, trace, TraceFlags } from '@opentelemetry/api';
import { expect, it, vi } from 'vitest';
import { createLogger } from './logger';
import { correlationKey } from './context';

it('writes one JSON line with the required Cloud Logging fields', () => {
  const write = vi.fn();
  const log = createLogger({ serviceName: 'draw-worker', projectId: 'test-project', write });
  log('INFO', 'Ready\nfor work');
  expect(write).toHaveBeenCalledTimes(1);
  const line = write.mock.calls[0][0] as string;
  expect(line.split('\n')).toHaveLength(2);
  expect(JSON.parse(line)).toMatchObject({ severity: 'INFO', message: 'Ready\nfor work', function: 'draw-worker', event_type: null, correlation_id: null, user_id: null });
});

it('links logs to the active sampled trace without spreading unknown fields', () => {
  const write = vi.fn();
  const active = trace.setSpanContext(ROOT_CONTEXT.setValue(correlationKey, 'corr-1'), {
    traceId: '0123456789abcdef0123456789abcdef', spanId: '0123456789abcdef', traceFlags: TraceFlags.SAMPLED,
  });
  const log = createLogger({ serviceName: 'worker', projectId: 'test-project', activeContext: () => active, write });
  const fields = { event_type: 'pixel-draw', user_id: '123', token: 'must-not-appear' };
  log('WARNING', 'Expected rejection', fields);
  expect(JSON.parse(write.mock.calls[0][0])).toMatchObject({
    correlation_id: 'corr-1', event_type: 'pixel-draw', user_id: '123',
    'logging.googleapis.com/trace': 'projects/test-project/traces/0123456789abcdef0123456789abcdef',
    'logging.googleapis.com/spanId': '0123456789abcdef',
    'logging.googleapis.com/trace_sampled': true,
  });
  expect(write.mock.calls[0][0]).not.toContain('must-not-appear');
});

it('handles invalid or unsampled trace contexts and defaults to stdout', () => {
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  try {
    const invalid = trace.setSpanContext(ROOT_CONTEXT, { traceId: '0'.repeat(32), spanId: '0'.repeat(16), traceFlags: 0 });
    createLogger({ serviceName: 'worker', projectId: 'test', activeContext: () => invalid })('DEBUG', 'Startup');
    expect(JSON.parse(stdout.mock.calls[0][0] as string)).not.toHaveProperty('logging.googleapis.com/trace');
    const valid = trace.setSpanContext(ROOT_CONTEXT, { traceId: '1'.repeat(32), spanId: '1'.repeat(16), traceFlags: 0 });
    createLogger({ serviceName: 'worker', projectId: 'test', activeContext: () => valid })('INFO', 'Not sampled');
    expect(JSON.parse(stdout.mock.calls[1][0] as string)['logging.googleapis.com/trace_sampled']).toBe(false);
  } finally {
    stdout.mockRestore();
  }
});
