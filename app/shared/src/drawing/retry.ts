import type { Firestore, Transaction } from '@google-cloud/firestore';

/**
 * Attempts of one draw transaction. The SDK default is 5 attempts with a 1 s, 1.5 s, 2.25 s...
 * backoff: under contention (dev, 27/11), 81 % of the group transactions were replayed and
 * the median one took 4.6 s for 0.3 s of work. Here: more attempts, much shorter waits.
 */
export const TRANSACTION_ATTEMPTS = 10;
export const RETRY_BASE_DELAY_MS = 25;
export const RETRY_MAX_DELAY_MS = 400;

/** Same codes as the SDK's own transaction retry (isRetryableTransactionError, transaction.js). */
const RETRYABLE_CODES = new Set([10 /* ABORTED */, 409, 1, 2, 4, 13, 14, 16, 8]);

export function isRetryableTransactionError(error: unknown): boolean {
  const { code, message } = (error ?? {}) as { code?: unknown; message?: unknown };
  if (typeof code !== 'number') return false; // Business errors (DrawProcessingError) carry a string code.
  if (RETRYABLE_CODES.has(code)) return true;
  return code === 3 /* INVALID_ARGUMENT */ && typeof message === 'string' && /transaction has expired/.test(message);
}

export interface RetryOptions {
  attempts?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

/**
 * runTransaction with our own retry loop: the SDK makes ONE attempt, then we wait a random
 * delay in [0, min(400, 25 x 2^(n-1))) ms ("full jitter") before the next one. Worst case of
 * all the waits: about 2.4 s, instead of more than 10 s with the SDK backoff.
 */
export async function runDrawTransaction<T>(
  db: Firestore, work: (tx: Transaction) => Promise<T>, options: RetryOptions = {},
): Promise<T> {
  const attempts = options.attempts ?? TRANSACTION_ATTEMPTS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
  const random = options.random ?? Math.random;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await db.runTransaction(work, { maxAttempts: 1 });
    } catch (error) {
      if (attempt >= attempts || !isRetryableTransactionError(error)) throw error;
      await sleep(Math.floor(random() * Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * 2 ** (attempt - 1))));
    }
  }
}
