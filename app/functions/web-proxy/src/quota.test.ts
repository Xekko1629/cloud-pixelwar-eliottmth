import { describe, expect, it, vi } from 'vitest';
import { createQuotaClient, parseReservation } from './quota';

const URL = 'https://quota-reserver-abc-ew.a.run.app';
const request = { reservation_id: 'a813cf97-0000-4000-8000-000000000001', uid: '123456789012345678', pixel_count: 500 };
const answer = { granted: 300, refused: 200, reason: 'insufficient_quota', retry_after_seconds: 40, limit_per_minute: 1000, remaining_pixels: 0, reset_at: '2026-11-27T15:31:00.000Z' };
function auth(...outcomes: unknown[]) {
  const send = vi.fn(async () => {
    const next = outcomes.shift();
    if (next instanceof Error) throw next;
    return { data: next };
  });
  const getIdTokenClient = vi.fn(async () => ({ request: send }));
  return { auth: { getIdTokenClient } as never, send, getIdTokenClient };
}
const httpError = (status: number) => Object.assign(new Error(`HTTP ${status}`), { response: { status } });

describe('parseReservation', () => {
  it('keeps an answer that adds up', () => { expect(parseReservation(answer, 500)).toEqual(answer); });
  it.each([
    null, { ...answer, granted: 501, refused: -1 }, { ...answer, refused: 100 }, { ...answer, reason: undefined },
    { ...answer, reason: 'other' }, { granted: 500, refused: 0, reason: 'paused', retry_after_seconds: null, limit_per_minute: 1, remaining_pixels: 0, reset_at: answer.reset_at },
    { ...answer, retry_after_seconds: 61 }, { ...answer, limit_per_minute: -1 }, { ...answer, reset_at: 'never' },
  ])('refuses %j', (value) => { expect(() => parseReservation(value, 500)).toThrow('Invalid quota-reserver answer'); });
});

describe('createQuotaClient', () => {
  it('posts the request with an ID token for the service URL, once', async () => {
    const { auth: client, send, getIdTokenClient } = auth(answer, answer);
    const reserve = createQuotaClient(URL, client);
    expect(await reserve(request)).toEqual(answer);
    await reserve(request);
    expect(getIdTokenClient).toHaveBeenCalledExactlyOnceWith(URL);
    expect(send).toHaveBeenCalledWith({ url: URL, method: 'POST', data: request, timeout: 5000, retry: false });
  });

  it('retries once on a network or server error with the same reservation id', async () => {
    const { auth: client, send } = auth(new Error('reset'), answer);
    expect(await createQuotaClient(URL, client)(request)).toEqual(answer);
    expect(send).toHaveBeenCalledTimes(2);
    const failing = auth(httpError(503), httpError(503));
    await expect(createQuotaClient(URL, failing.auth)(request)).rejects.toThrow('HTTP 503');
  });

  it('does not retry a refused call, and refuses a wrong answer', async () => {
    const refused = auth(httpError(403));
    await expect(createQuotaClient(URL, refused.auth)(request)).rejects.toThrow('HTTP 403');
    expect(refused.send).toHaveBeenCalledTimes(1);
    await expect(createQuotaClient(URL, auth({ granted: 9999 }, { granted: 9999 }).auth)(request)).rejects.toThrow('Invalid');
  });
});
