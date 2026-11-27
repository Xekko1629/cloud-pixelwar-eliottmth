import type { HttpFunction } from '@google-cloud/functions-framework';
import { describe, expect, it, vi } from 'vitest';
import { createQuotaReserverHandler, handleQuotaReserver } from './index';

const body = { reservation_id: 'a813cf97-0000-4000-8000-000000000001', uid: '123456789012345678', pixel_count: 500 };
const granted = { granted: 300, refused: 200, reason: 'insufficient_quota', retry_after_seconds: 40, limit_per_minute: 1000, remaining_pixels: 0, reset_at: '2026-11-27T15:31:00.000Z' };

async function call(handler: HttpFunction, request: Record<string, unknown> = {}) {
  const res = { status: vi.fn(), json: vi.fn(), set: vi.fn() };
  res.status.mockReturnValue(res); res.set.mockReturnValue(res);
  const raw = Buffer.from(JSON.stringify(body));
  await handler({ path: '/', method: 'POST', rawBody: raw, ...request } as unknown as Parameters<HttpFunction>[0], res as unknown as Parameters<HttpFunction>[1]);
  return res;
}
function setup(reserve = vi.fn().mockResolvedValue(granted)) {
  const lines: string[] = [];
  return { reserve, lines, handler: createQuotaReserverHandler({ reserve, write: (line) => lines.push(line) }) };
}

describe('quota-reserver (ADR-0017)', () => {
  it('reserves and answers the reservation, logging without the uid', async () => {
    const { handler, reserve, lines } = setup();
    const res = await call(handler);
    expect(reserve).toHaveBeenCalledWith(body);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(granted);
    expect(JSON.parse(lines[0])).toEqual({ severity: 'INFO', function: 'quota-reserver', event_type: 'quota.reserved',
      correlation_id: body.reservation_id, requested: 500, granted: 300, reason: 'insufficient_quota' });
    expect(lines.join('')).not.toContain(body.uid);
  });

  it('logs a full refusal', async () => {
    const { handler, lines } = setup(vi.fn().mockResolvedValue({ ...granted, granted: 0, refused: 500 }));
    await call(handler);
    expect(JSON.parse(lines[0]).event_type).toBe('quota.refused');
  });

  it.each([
    [{ path: '/x' }, 404], [{ method: 'GET' }, 405], [{ rawBody: Buffer.alloc(2048) }, 413], [{ rawBody: undefined }, 413],
    [{ rawBody: Buffer.from('{') }, 400], [{ rawBody: Buffer.from(JSON.stringify({ ...body, pixel_count: 0 })) }, 400],
  ])('refuses %j with %i without reserving', async (request, status) => {
    const { handler, reserve } = setup();
    expect((await call(handler, request)).status).toHaveBeenCalledWith(status);
    expect(reserve).not.toHaveBeenCalled();
  });

  it('answers 503 without the error when Firestore fails, or without configuration', async () => {
    const { handler, lines } = setup(vi.fn().mockRejectedValue(new Error(`users/${body.uid} denied`)));
    expect((await call(handler)).status).toHaveBeenCalledWith(503);
    expect(lines.join('')).not.toContain(body.uid);
    expect((await call(createQuotaReserverHandler({}))).status).toHaveBeenCalledWith(503);
    expect((await call(handleQuotaReserver)).status).toHaveBeenCalledWith(503); // No GOOGLE_CLOUD_PROJECT in tests.
  });
});
