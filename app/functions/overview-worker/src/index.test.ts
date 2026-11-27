import type { HttpFunction } from '@google-cloud/functions-framework';
import { describe, expect, it, vi } from 'vitest';
import { STALE_TICK_MS, createOverviewWorkerHandler } from './index';
import { parseTickPush } from './message';
import { ConcurrentCycleError, StoredDataError } from './store';

const subscription = 'projects/pixelwar-test/subscriptions/overview-worker';
const now = Date.parse('2026-11-26T12:00:00.000Z');
const push = (changes: Record<string, unknown> = {}) => ({
  subscription, message: { messageId: '42', publishTime: new Date(now - 1000).toISOString(), data: 'dGljaw==', ...changes },
});
const summary = { mode: 'incremental' as const, canvas_version: 1, rendered: { 1: 1, 2: 1, 3: 1 }, removed: 0, pending: 0 };

function call(handler: HttpFunction, body: unknown, request: Record<string, unknown> = {}) {
  const res = { status: vi.fn(), json: vi.fn(), send: vi.fn(), set: vi.fn() };
  res.status.mockReturnValue(res); res.set.mockReturnValue(res);
  const raw = (request.rawBody as Buffer | undefined) ?? Buffer.from(JSON.stringify(body));
  return Promise.resolve().then(() => handler({ path: '/', method: 'POST', body, rawBody: raw, ...request } as Parameters<HttpFunction>[0],
    res as unknown as Parameters<HttpFunction>[1])).then(() => res);
}
const setup = (cycle = vi.fn(async () => summary)) => {
  const lines: string[] = [];
  const handler = createOverviewWorkerHandler({ subscription, cycle, now: () => now, write: (line) => { lines.push(line); } });
  return { handler, cycle, logs: () => lines.map((line) => JSON.parse(line)) };
};

describe('parseTickPush', () => {
  it('keeps the message id and publish time only', () => {
    expect(parseTickPush(push(), subscription)).toEqual({ message_id: '42', published_ms: now - 1000 });
  });
  it.each([
    [{ subscription: 'projects/x/subscriptions/other', message: push().message }],
    [push({ messageId: '0' })], [push({ messageId: 7 })], [push({ publishTime: 'yesterday' })], [push({ publishTime: '2026-11-26' })],
    [{ subscription }], [null],
  ])('refuses %j', (body) => {
    expect(() => parseTickPush(body, subscription)).toThrow('invalid_envelope');
  });
});

describe('overview-worker handler', () => {
  it('runs one cycle per fresh tick and logs its summary', async () => {
    const { handler, cycle, logs } = setup();
    expect((await call(handler, push())).status).toHaveBeenCalledWith(204);
    expect(cycle).toHaveBeenCalledTimes(1);
    expect(logs()).toEqual([{ severity: 'INFO', function: 'overview-worker', event_type: 'overview.cycle.done', message_id: '42', duration_ms: 0, ...summary }]);
  });
  it('acknowledges a stale tick without working', async () => {
    const { handler, cycle, logs } = setup();
    const res = await call(handler, push({ publishTime: new Date(now - STALE_TICK_MS - 1).toISOString() }));
    expect(res.status).toHaveBeenCalledWith(204);
    expect(cycle).not.toHaveBeenCalled();
    expect(logs()[0].event_type).toBe('overview.tick.stale');
  });
  it('acknowledges a tick that lost the race against another cycle', async () => {
    const { handler, logs } = setup(vi.fn(async () => { throw new ConcurrentCycleError(); }));
    expect((await call(handler, push())).status).toHaveBeenCalledWith(204);
    expect(logs()[0]).toMatchObject({ severity: 'WARNING', event_type: 'overview.cycle.concurrent' });
  });
  it.each([
    [new StoredDataError('bad tile'), { reason: 'stored_data' }], [new Error('secret-detail'), {}],
  ])('asks for a retry when the cycle fails, without logging the error', async (error, fields) => {
    const { handler, logs } = setup(vi.fn(async () => { throw error; }));
    expect((await call(handler, push())).status).toHaveBeenCalledWith(503);
    expect(logs()).toEqual([{ severity: 'ERROR', function: 'overview-worker', event_type: 'overview.cycle.failed', message_id: '42', ...fields }]);
    expect(JSON.stringify(logs())).not.toContain('secret-detail');
    expect(JSON.stringify(logs())).not.toContain('bad tile');
  });
  it('refuses an invalid envelope with 400 so that it reaches the DLQ', async () => {
    const { handler, cycle, logs } = setup();
    expect((await call(handler, { subscription: 'other' })).status).toHaveBeenCalledWith(400);
    expect(cycle).not.toHaveBeenCalled();
    expect(logs()[0]).toMatchObject({ event_type: 'overview.message.invalid', reason: 'invalid_envelope' });
  });
  it('answers 503 without configuration and refuses other paths, methods and sizes', async () => {
    expect((await call(createOverviewWorkerHandler({}), push())).status).toHaveBeenCalledWith(503);
    const { handler } = setup();
    expect((await call(handler, push(), { path: '/x' })).status).toHaveBeenCalledWith(404);
    expect((await call(handler, push(), { method: 'GET' })).status).toHaveBeenCalledWith(405);
    expect((await call(handler, push(), { rawBody: Buffer.alloc(17 * 1024) })).status).toHaveBeenCalledWith(413);
  });
  it('never fails because of logging', async () => {
    const handler = createOverviewWorkerHandler({ subscription, cycle: async () => summary, now: () => now, write: () => { throw new Error('stdout'); } });
    expect((await call(handler, push())).status).toHaveBeenCalledWith(204);
  });
  it('rethrows an unexpected parsing failure', async () => {
    const { handler } = setup();
    const body = { get subscription() { throw new TypeError('boom'); } };
    await expect(call(handler, body, { rawBody: Buffer.from('{}') })).rejects.toThrow('boom');
  });
});
