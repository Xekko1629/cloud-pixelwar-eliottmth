import type { Firestore } from '@google-cloud/firestore';
import { describe, expect, it, vi } from 'vitest';
import { RETRY_MAX_DELAY_MS, TRANSACTION_ATTEMPTS, isRetryableTransactionError, runDrawTransaction } from './retry';

const failure = (code: unknown, message = 'failed') => Object.assign(new Error(message), { code });
function store(outcomes: unknown[]) {
  const runTransaction = vi.fn(async (work: (tx: unknown) => Promise<unknown>, options: unknown) => {
    void options;
    const next = outcomes.shift();
    if (next instanceof Error) throw next;
    return work({});
  });
  return { db: { runTransaction } as unknown as Firestore, runTransaction };
}

describe('isRetryableTransactionError', () => {
  it.each([10, 409, 1, 2, 4, 13, 14, 16, 8])('retries the SDK retryable code %i', (code) => {
    expect(isRetryableTransactionError(failure(code))).toBe(true);
  });
  it('retries an expired transaction only', () => {
    expect(isRetryableTransactionError(failure(3, 'The referenced transaction has expired'))).toBe(true);
    expect(isRetryableTransactionError(failure(3, 'bad field'))).toBe(false);
  });
  it.each([failure(7), failure('rate_limit'), new Error('plain'), null, 'text'])('never retries %s', (error) => {
    expect(isRetryableTransactionError(error)).toBe(false);
  });
});

describe('runDrawTransaction', () => {
  it('makes one SDK attempt at a time and replays an aborted one after a short random wait', async () => {
    const { db, runTransaction } = store([failure(10), failure(10)]);
    const sleep = vi.fn(async (ms: number) => { void ms; });
    expect(await runDrawTransaction(db, async () => 'done', { sleep, random: () => 0.5 })).toBe('done');
    expect(runTransaction).toHaveBeenCalledTimes(3);
    expect(runTransaction.mock.calls.every(([, options]) => (options as { maxAttempts: number }).maxAttempts === 1)).toBe(true);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([12, 25]); // Half of 25 then of 50 ms.
  });

  it('caps every wait and stops after the last attempt', async () => {
    const { db, runTransaction } = store(Array.from({ length: TRANSACTION_ATTEMPTS }, () => failure(10)));
    const sleep = vi.fn(async (ms: number) => { void ms; });
    await expect(runDrawTransaction(db, async () => 'never', { sleep, random: () => 0.999 })).rejects.toMatchObject({ code: 10 });
    expect(runTransaction).toHaveBeenCalledTimes(TRANSACTION_ATTEMPTS);
    expect(sleep).toHaveBeenCalledTimes(TRANSACTION_ATTEMPTS - 1);
    expect(Math.max(...sleep.mock.calls.map(([ms]) => ms))).toBeLessThan(RETRY_MAX_DELAY_MS);
    const total = sleep.mock.calls.reduce((sum, [ms]) => sum + ms, 0);
    expect(total).toBeLessThan(2_400); // Instead of more than 10 s with the SDK backoff.
  });

  it('fails at once on a business error', async () => {
    const { db, runTransaction } = store([]);
    const sleep = vi.fn();
    await expect(runDrawTransaction(db, async () => { throw failure('invalid_command'); }, { sleep })).rejects.toMatchObject({ code: 'invalid_command' });
    expect(runTransaction).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('waits with a real timer by default', async () => {
    const { db } = store([failure(14)]);
    expect(await runDrawTransaction(db, async () => 'ok', { random: () => 0 })).toBe('ok');
  });
});
