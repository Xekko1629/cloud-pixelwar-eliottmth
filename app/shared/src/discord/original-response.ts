// Edits the deferred response of a Discord interaction (PATCH @original), shared by the
// functions that answer a slash command: discord-notifier (BOT-05), admin-worker (BOT-08),
// and later render-worker (BOT-06). Node 24 native fetch, no Discord SDK.

/** An interaction token stays valid 15 minutes after the interaction (Discord). */
export const TOKEN_LIFETIME_MS = 15 * 60_000;
/**
 * A 404 younger than this may only mean Discord has not yet stored the deferred answer:
 * it stays retryable. Older, the interaction was never acknowledged (e.g. a proxy cold
 * start beyond 3 s, seen in dev on 21/11) and no retry can ever edit it.
 */
export const UNKNOWN_INTERACTION_AFTER_MS = 10_000;
const DISCORD_EPOCH_MS = 1_420_070_400_000n;

/** The token is a secret: it never reaches a log, a span, an error message or Firestore. */
export interface OriginalResponseTarget {
  application_id: string;
  interaction_token: string;
  /** Interaction creation time from its snowflake, in ms: the token expiry is computed from it. */
  created_at: number;
}
export interface OriginalResponseBody {
  content: string;
  allowed_mentions: { parse: string[] };
  embeds: never[];
  components: never[];
}
/**
 * - updated: the message shows the new content;
 * - expired: the 15-minute token is over, the message can no longer be edited;
 * - unknown_interaction: Discord answered 404 (Unknown Webhook) for an interaction older than
 *   UNKNOWN_INTERACTION_AFTER_MS: the deferred response was never acknowledged in time.
 */
export type EditOutcome = 'updated' | 'expired' | 'unknown_interaction';
/** One PNG sent with the answer (/get, BOT-06). The edit replaces any previous attachment. */
export interface ResponseAttachment { filename: string; data: Uint8Array }
export type EditOriginalResponse = (target: OriginalResponseTarget, body: OriginalResponseBody, file?: ResponseAttachment) => Promise<EditOutcome>;

/** An image upload takes longer than a text edit: up to 9.5 MiB (DISCORD_UPLOAD_LIMIT_BYTES). */
export const UPLOAD_TIMEOUT_MS = 30_000;
const FILENAME = /^[a-z0-9][a-z0-9-]{0,62}\.png$/;

export class NotificationFailure extends Error {
  constructor(readonly reason: 'network' | 'http' | 'rate_limited' | 'invalid_clock', readonly status?: number, readonly retryAfterSeconds?: number) {
    // Deliberately no URL, response body, token, original Error or cause.
    super('Discord notification unavailable.');
  }
}

/** Creation time encoded in a Discord snowflake. */
export function snowflakeTime(id: string): number {
  return Number((BigInt(id) >> 22n) + DISCORD_EPOCH_MS);
}

/** Plain text answer: no mention can ping anyone, no embed or component. */
export function textResponse(content: string): OriginalResponseBody {
  return { content, allowed_mentions: { parse: [] }, embeds: [], components: [] };
}

interface Options { fetch?: typeof fetch; now?: () => number; timeoutMs?: number }

export function createOriginalResponseEditor(options: Options = {}): EditOriginalResponse {
  const request = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const timeout = options.timeoutMs ?? 5000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 10_000) throw new Error('Invalid Discord request timeout');
  const clock = () => {
    const value = now();
    if (!Number.isSafeInteger(value) || value < 0) throw new NotificationFailure('invalid_clock');
    return value;
  };
  return async (target, body, file) => {
    if (file && (!FILENAME.test(file.filename) || !(file.data instanceof Uint8Array) || file.data.byteLength < 1)) {
      throw new Error('Invalid attachment');
    }
    const expires = target.created_at + TOKEN_LIFETIME_MS;
    const start = clock();
    if (start < target.created_at - 5000) throw new NotificationFailure('invalid_clock');
    if (start >= expires) return 'expired';
    try {
      // Fixed host, encoded token, no redirect: the token can never be sent elsewhere.
      const response = await request(
        `https://discord.com/api/v10/webhooks/${target.application_id}/${encodeURIComponent(target.interaction_token)}/messages/@original`,
        { method: 'PATCH', redirect: 'error', ...requestBody(body, file),
          signal: AbortSignal.timeout(Math.min(file ? UPLOAD_TIMEOUT_MS : timeout, expires - start)) },
      );
      // The response may contain message content or credentials: never read or log it.
      try { await response.body?.cancel(); } catch { /* Discarding a body cannot invalidate a successful PATCH. */ }
      if (response.ok) return 'updated';
      if (response.status === 404 && start - target.created_at >= UNKNOWN_INTERACTION_AFTER_MS) return 'unknown_interaction';
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

/** JSON for a text edit; multipart with payload_json and files[0] for an image (Discord API v10). */
function requestBody(body: OriginalResponseBody, file?: ResponseAttachment): { headers?: Record<string, string>; body: string | FormData } {
  if (!file) return { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  const form = new FormData();
  // Listing only the new file removes the attachment of an earlier delivery: no duplicate image.
  form.append('payload_json', JSON.stringify({ ...body, attachments: [{ id: 0, filename: file.filename }] }));
  // Copy into a plain ArrayBuffer: Blob refuses a view over a SharedArrayBuffer.
  form.append('files[0]', new Blob([Uint8Array.from(file.data)], { type: 'image/png' }), file.filename);
  return { body: form };
}
