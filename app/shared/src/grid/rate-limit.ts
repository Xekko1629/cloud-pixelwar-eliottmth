import { validateTimestamp } from './metadata';
import type { GlobalConfigDocument, RateLimitOverrideDocument, TimestampValue, UserStateDocument } from './model';

export const RATE_LIMIT_WINDOW_MS = 60_000;
// Initialization value only: never silently substitute it for missing config.
export const INITIAL_DEFAULT_LIMIT_PER_MINUTE = 20;

export type RateLimitErrorCode = 'invalid_configuration' | 'invalid_usage' | 'invalid_clock' | 'invalid_pixel_count';
export class RateLimitDataError extends Error {
  readonly code: RateLimitErrorCode;

  constructor(code: RateLimitErrorCode, message: string) {
    super(message);
    this.name = 'RateLimitDataError';
    this.code = code;
  }
}

export type RateLimitUsage = Pick<UserStateDocument, 'window_start' | 'used_pixels' | 'updated_at'>;
export interface RateLimitInput {
  config: Pick<GlobalConfigDocument, 'default_limit_per_minute'> | null | undefined;
  override?: Pick<RateLimitOverrideDocument, 'limit_per_minute'> | null;
  usage?: RateLimitUsage | null;
  // Inject the worker's clock on EVERY transaction attempt, never occurred_at/client time.
  now_ms: number;
  pixel_count: number;
}

interface QuotaSummary {
  limit_per_minute: number;
  requested_pixels: number;
  used_before: number;
  remaining_pixels: number;
  window_start_ms: number;
  reset_at_ms: number;
}

export type RateLimitDecision = QuotaSummary & (
  {
    allowed: true;
    // Numeric proposal, NOT a Firestore document: adapt times to SDK Timestamps.
    next_usage: { window_start_ms: number; used_pixels: number; limit_per_minute: number; updated_at_ms: number };
  } |
  {
    allowed: false;
    reason: 'drawing_disabled' | 'batch_exceeds_limit' | 'insufficient_quota';
    // null: waiting for another minute alone cannot make this request fit.
    retry_after_seconds: number | null;
  }
);

export function resolveRateLimit(
  config: RateLimitInput['config'], override?: RateLimitInput['override'],
): number {
  // Validate the global value even when there is an override: malformed config
  // must not silently become an operational rule for some users only.
  const defaultLimit = readLimit(config?.default_limit_per_minute, 'default_limit_per_minute');
  return override == null ? defaultLimit : readLimit(override.limit_per_minute, 'override.limit_per_minute');
}

/** Pure decision only. This does NOT reserve quota, persist a refusal or deduplicate. */
export function evaluateRateLimit(input: RateLimitInput): RateLimitDecision {
  const limit = resolveRateLimit(input.config, input.override);
  if (!Number.isSafeInteger(input.pixel_count) || input.pixel_count < 1) {
    throw new RateLimitDataError('invalid_pixel_count', 'pixel_count must be a positive safe integer');
  }
  if (!Number.isSafeInteger(input.now_ms) || input.now_ms < 0) {
    throw new RateLimitDataError('invalid_clock', 'now_ms must be a nonnegative safe integer from the worker');
  }
  const windowStart = Math.floor(input.now_ms / RATE_LIMIT_WINDOW_MS) * RATE_LIMIT_WINDOW_MS;
  const resetAt = windowStart + RATE_LIMIT_WINDOW_MS;
  try {
    validateTimestamp({ seconds: resetAt / 1000, nanoseconds: 0 });
  } catch {
    throw new RateLimitDataError('invalid_clock', 'Quota window must fit the Firestore timestamp range');
  }
  const used = currentUsage(input.usage, windowStart, input.now_ms);
  const remaining = Math.max(0, limit - used);
  const summary: QuotaSummary = {
    limit_per_minute: limit, requested_pixels: input.pixel_count, used_before: used,
    remaining_pixels: remaining, window_start_ms: windowStart, reset_at_ms: resetAt,
  };

  if (limit === 0) return { ...summary, allowed: false, reason: 'drawing_disabled', retry_after_seconds: null };
  if (input.pixel_count > limit) return { ...summary, allowed: false, reason: 'batch_exceeds_limit', retry_after_seconds: null };
  if (input.pixel_count > remaining) {
    return {
      ...summary, allowed: false, reason: 'insufficient_quota',
      retry_after_seconds: Math.ceil((resetAt - input.now_ms) / 1000),
    };
  }
  // Check against remaining BEFORE addition: even MAX_SAFE_INTEGER limits are safe.
  return {
    ...summary, allowed: true, remaining_pixels: remaining - input.pixel_count,
    next_usage: {
      window_start_ms: windowStart, used_pixels: used + input.pixel_count,
      limit_per_minute: limit, updated_at_ms: input.now_ms,
    },
  };
}

function readLimit(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new RateLimitDataError('invalid_configuration', `${field} must be a nonnegative safe integer`);
  }
  return value;
}

function currentUsage(usage: RateLimitInput['usage'], windowStart: number, now: number): number {
  if (usage == null) return 0;
  const storedStart = timestampMillis(usage.window_start);
  const updatedAt = timestampMillis(usage.updated_at);
  if (usage.window_start.nanoseconds !== 0 || storedStart < 0 || storedStart % RATE_LIMIT_WINDOW_MS !== 0 ||
      storedStart > windowStart || updatedAt < storedStart || updatedAt > now ||
      !Number.isSafeInteger(usage.used_pixels) || usage.used_pixels < 0) {
    throw new RateLimitDataError('invalid_usage', 'Invalid or future quota usage; do not reset it automatically');
  }
  return storedStart === windowStart ? usage.used_pixels : 0;
}

function timestampMillis(value: TimestampValue): number {
  try {
    validateTimestamp(value);
    return value.seconds * 1000 + value.nanoseconds / 1_000_000;
  } catch {
    throw new RateLimitDataError('invalid_usage', 'Quota usage timestamps must be valid Firestore timestamps');
  }
}
