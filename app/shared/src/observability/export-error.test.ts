import { describe, expect, it, vi } from 'vitest';
import { exportFailureReason, observeExportFailures } from './export-error';

describe('telemetry export failures', () => {
  it.each([
    [Object.assign(new Error('Bad Request'), { code: 400 }), 'http_400'],
    [Object.assign(new Error('Service Unavailable'), { code: 503 }), 'http_503'],
    [new Error('Timeout'), 'timeout'],
    [new Error('Request Time out'), 'timeout'],
    [new Error('Request timed out'), 'other'],
    [Object.assign(new Error('x'), { code: 14 }), 'other'], // gRPC code, not HTTP.
    [Object.assign(new Error('x'), { code: '503' }), 'other'],
    [undefined, 'other'],
  ])('classifies %s as %s', (error, reason) => {
    expect(exportFailureReason(error)).toBe(reason);
  });

  it('reports each failed export with its signal and reason, and passes every result on unchanged', () => {
    const results = [{ code: 0 }, { code: 1, error: Object.assign(new Error('synthetic-body'), { code: 400 }) }];
    const exporter = { export: (_items: string[], done: (result: { code: number; error?: Error }) => void) => { done(results.shift()!); } };
    const onFailure = vi.fn();
    const observed = observeExportFailures(exporter, 'metrics', onFailure);
    const done = vi.fn();
    observed.export(['a'], done); observed.export(['b'], done);
    expect(onFailure.mock.calls).toEqual([['metrics', 'http_400']]);
    expect(done.mock.calls.map(([result]) => result.code)).toEqual([0, 1]);
  });

  it('never fails an export because the listener throws', () => {
    const exporter = { export: (_items: string[], done: (result: { code: number }) => void) => { done({ code: 1 }); } };
    const done = vi.fn();
    observeExportFailures(exporter, 'traces', () => { throw new Error('listener'); }).export([], done);
    expect(done).toHaveBeenCalledWith({ code: 1 });
  });
});
