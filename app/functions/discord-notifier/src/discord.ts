import { originalResponseContent } from './content';
import { TOKEN_LIFETIME_MS, type DiscordNotice } from './message';

export type UpdateOriginal = (notice: DiscordNotice) => Promise<'updated' | 'expired'>;
export class NotificationFailure extends Error {
  constructor(readonly reason: 'network' | 'http' | 'rate_limited' | 'invalid_clock', readonly status?: number, readonly retryAfterSeconds?: number) {
    // Deliberately no URL, response body, token, original Error or cause.
    super('Discord notification unavailable.');
  }
}
interface Options { fetch?: typeof fetch; now?: () => number; timeoutMs?: number }

export function createOriginalResponseUpdater(options: Options = {}): UpdateOriginal {
  const request = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const timeout = options.timeoutMs ?? 5000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 10_000) throw new Error('Invalid Discord request timeout');
  const clock = () => {
    const value = now();
    if (!Number.isSafeInteger(value) || value < 0) throw new NotificationFailure('invalid_clock');
    return value;
  };
  return async (notice) => {
    const expires = notice.discord.created_at + TOKEN_LIFETIME_MS;
    const start = clock();
    if (start < notice.discord.created_at - 5000) throw new NotificationFailure('invalid_clock');
    if (start >= expires) return 'expired';
    try {
      const response = await request(
        `https://discord.com/api/v10/webhooks/${notice.discord.application_id}/${encodeURIComponent(notice.discord.interaction_token)}/messages/@original`,
        { method: 'PATCH', redirect: 'error', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(originalResponseContent(notice.result)),
          signal: AbortSignal.timeout(Math.min(timeout, expires - start)) },
      );
      // The response may contain message content or credentials: never read or log it.
      try { await response.body?.cancel(); } catch { /* Discarding a body cannot invalidate a successful PATCH. */ }
      if (response.ok) return 'updated';
      if (clock() >= expires) return 'expired';
      const retryAfter = response.headers.get('Retry-After');
      const delay = retryAfter && /^\d+(?:\.\d+)?$/.test(retryAfter) ? Number(retryAfter) : undefined;
      throw new NotificationFailure(response.status === 429 ? 'rate_limited' : 'http', response.status,
        delay !== undefined && Number.isFinite(delay) && delay > 0 ? Math.min(900, Math.ceil(delay)) : undefined);
    } catch (error) {
      if (error instanceof NotificationFailure) throw error;
      if (clock() >= expires) return 'expired';
      throw new NotificationFailure('network');
    }
  };
}
