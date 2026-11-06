import { describe, expect, it } from 'vitest';
import {
  evaluateRateLimit, resolveRateLimit, RateLimitDataError,
  INITIAL_DEFAULT_LIMIT_PER_MINUTE, RATE_LIMIT_WINDOW_MS,
  type RateLimitInput, type RateLimitUsage, type RateLimitErrorCode,
} from './rate-limit';
import type { TimestampValue } from './model';

const now = Date.parse('2026-11-06T12:34:42.123Z');
const start = Date.parse('2026-11-06T12:34:00.000Z');
const reset = start + 60_000;
const stamp = (ms: number): TimestampValue => ({ seconds: Math.floor(ms / 1000), nanoseconds: (ms % 1000) * 1_000_000 });
const usage = (count: number, window = start, updated = window): RateLimitUsage => ({
  window_start: stamp(window), used_pixels: count, updated_at: stamp(updated),
});
const decide = (input: Partial<RateLimitInput> = {}) => evaluateRateLimit({
  config: { default_limit_per_minute: 20 }, now_ms: now, pixel_count: 1, ...input,
});
function technicalFailure(work: () => unknown, code: RateLimitErrorCode): void {
  let failure: unknown;
  try { work(); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(RateLimitDataError);
  expect(failure).toMatchObject({ name: 'RateLimitDataError', code });
}

describe('quota configuration', () => {
  it('exports 20 only as initialization value, with a 60-second window', () => {
    expect(INITIAL_DEFAULT_LIMIT_PER_MINUTE).toBe(20);
    expect(RATE_LIMIT_WINDOW_MS).toBe(60_000);
  });
  it.each([0, 1, 20, 500, Number.MAX_SAFE_INTEGER])('accepts a safe nonnegative global limit %s', (limit) => {
    expect(resolveRateLimit({ default_limit_per_minute: limit })).toBe(limit);
  });
  it('uses the global limit for an absent override document', () => {
    expect(resolveRateLimit({ default_limit_per_minute: 20 }, null)).toBe(20);
    expect(resolveRateLimit({ default_limit_per_minute: 20 }, undefined)).toBe(20);
  });
  it.each([0, 1, 30, 500, Number.MAX_SAFE_INTEGER])('gives a valid override %s priority', (limit) => {
    expect(resolveRateLimit({ default_limit_per_minute: 20 }, { limit_per_minute: limit })).toBe(limit);
  });
  const invalidLimits = [undefined, null, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '20', false];
  it.each(invalidLimits.map((limit) => ({ limit })))('rejects malformed global quota $limit even with a valid override', ({ limit }) => {
    technicalFailure(() => resolveRateLimit({ default_limit_per_minute: limit as number }, { limit_per_minute: 20 }), 'invalid_configuration');
  });
  it.each(invalidLimits.map((limit) => ({ limit })))('does not silently ignore a malformed override $limit', ({ limit }) => {
    technicalFailure(() => resolveRateLimit({ default_limit_per_minute: 20 }, { limit_per_minute: limit as number }), 'invalid_configuration');
  });
  it.each([null, undefined, {}])('never falls back to 20 for missing config %j', (config) => {
    technicalFailure(() => decide({ config: config as RateLimitInput['config'] }), 'invalid_configuration');
  });
});

describe('fixed UTC windows', () => {
  it('accepts the first pixel without an existing user document', () => {
    expect(decide({ usage: null })).toEqual({
      allowed: true, limit_per_minute: 20, requested_pixels: 1, used_before: 0,
      remaining_pixels: 19, window_start_ms: start, reset_at_ms: reset,
      next_usage: { window_start_ms: start, used_pixels: 1, limit_per_minute: 20, updated_at_ms: now },
    });
  });
  it.each([start, start + 1, reset - 1])('keeps the same window at %s', (time) => {
    const result = decide({ now_ms: time, usage: usage(15), pixel_count: 5 });
    expect(result).toMatchObject({ allowed: true, used_before: 15, window_start_ms: start, reset_at_ms: reset, remaining_pixels: 0 });
  });
  it('starts a fresh window exactly at the next minute', () => {
    expect(decide({ now_ms: reset, usage: usage(20) })).toMatchObject({
      allowed: true, used_before: 0, window_start_ms: reset, reset_at_ms: reset + 60_000, remaining_pixels: 19,
    });
  });
  it('resets logically after several idle minutes without a scheduled reset job', () => {
    expect(decide({ now_ms: start + 180_000, usage: usage(20) })).toMatchObject({ allowed: true, used_before: 0, remaining_pixels: 19 });
  });
  it('works at epoch zero and across UTC midnight', () => {
    expect(decide({ now_ms: 0 })).toMatchObject({ window_start_ms: 0, reset_at_ms: 60_000 });
    const midnight = Date.parse('2026-11-07T00:00:00.000Z');
    expect(decide({ now_ms: midnight, usage: usage(20, midnight - 60_000) }))
      .toMatchObject({ allowed: true, used_before: 0, window_start_ms: midnight });
  });
  it('exposes the deliberate burst at the boundary of two fixed windows', () => {
    expect(decide({ now_ms: reset - 1, pixel_count: 20 })).toMatchObject({ allowed: true, remaining_pixels: 0 });
    expect(decide({ now_ms: reset, usage: usage(20, start, reset - 1), pixel_count: 20 }))
      .toMatchObject({ allowed: true, remaining_pixels: 0, used_before: 0 });
  });
});

describe('batch charging and actionable denials', () => {
  it('counts each pixel of a brush and accepts exactly the available quota', () => {
    expect(decide({ usage: usage(15), pixel_count: 5 })).toMatchObject({
      allowed: true, remaining_pixels: 0, next_usage: { used_pixels: 20 },
    });
  });
  it('rejects a whole batch without a counter write or partial consumption', () => {
    const result = decide({ usage: usage(17), pixel_count: 5 });
    expect(result).toEqual({
      allowed: false, reason: 'insufficient_quota', retry_after_seconds: 18,
      limit_per_minute: 20, requested_pixels: 5, used_before: 17,
      remaining_pixels: 3, window_start_ms: start, reset_at_ms: reset,
    });
    expect(result).not.toHaveProperty('next_usage');
  });
  it.each([
    { time: start, seconds: 60 }, { time: start + 42_000, seconds: 18 },
    { time: reset - 1000, seconds: 1 }, { time: reset - 1, seconds: 1 },
  ])('rounds the retry delay up at $time', ({ time, seconds }) => {
    expect(decide({ now_ms: time, usage: usage(20) })).toMatchObject({ allowed: false, retry_after_seconds: seconds });
  });
  it('does not promise that a 5x5 brush fits a 20-pixel quota next minute', () => {
    expect(decide({ pixel_count: 25 })).toMatchObject({
      allowed: false, reason: 'batch_exceeds_limit', retry_after_seconds: null, remaining_pixels: 20,
    });
  });
  it('makes the same brush possible with a demo override', () => {
    expect(decide({ pixel_count: 25, override: { limit_per_minute: 1000 } }))
      .toMatchObject({ allowed: true, remaining_pixels: 975, next_usage: { used_pixels: 25 } });
  });
  it('never treats a zero override as missing or unlimited', () => {
    expect(decide({ override: { limit_per_minute: 0 } })).toMatchObject({
      allowed: false, reason: 'drawing_disabled', retry_after_seconds: null,
      remaining_pixels: 0, limit_per_minute: 0,
    });
  });
  it('allows an override to raise a zero default: this is not the global pause flag', () => {
    expect(decide({ config: { default_limit_per_minute: 0 }, override: { limit_per_minute: 10 } }))
      .toMatchObject({ allowed: true, remaining_pixels: 9 });
  });
  it('handles the maximum safe quota without overflowing on acceptance', () => {
    expect(decide({ config: { default_limit_per_minute: Number.MAX_SAFE_INTEGER }, usage: usage(Number.MAX_SAFE_INTEGER - 1) }))
      .toMatchObject({ allowed: true, remaining_pixels: 0, next_usage: { used_pixels: Number.MAX_SAFE_INTEGER } });
  });
  it('compares against remaining quota before adding a large request', () => {
    expect(decide({ config: { default_limit_per_minute: Number.MAX_SAFE_INTEGER }, usage: usage(Number.MAX_SAFE_INTEGER), pixel_count: Number.MAX_SAFE_INTEGER }))
      .toMatchObject({ allowed: false, reason: 'insufficient_quota', remaining_pixels: 0 });
  });
});

describe('immediate quota changes without free resets', () => {
  it('keeps usage when the effective limit increases during the minute', () => {
    expect(decide({ usage: usage(15), override: { limit_per_minute: 30 }, pixel_count: 15 }))
      .toMatchObject({ allowed: true, used_before: 15, remaining_pixels: 0, next_usage: { used_pixels: 30 } });
  });
  it('clamps remaining to zero when the new limit is below current usage', () => {
    expect(decide({ usage: usage(15), override: { limit_per_minute: 10 } }))
      .toMatchObject({ allowed: false, used_before: 15, remaining_pixels: 0, reason: 'insufficient_quota' });
  });
  it('applies a changed global default immediately, without resetting the count', () => {
    expect(decide({ usage: usage(15), config: { default_limit_per_minute: 10 } }))
      .toMatchObject({ allowed: false, limit_per_minute: 10, remaining_pixels: 0 });
  });
  it('uses the current config after override removal, not the stored limit snapshot', () => {
    const stored = { ...usage(15), limit_per_minute: 1000 };
    expect(decide({ usage: stored, override: null, pixel_count: 6 }))
      .toMatchObject({ allowed: false, limit_per_minute: 20, used_before: 15, remaining_pixels: 5 });
  });
  it('keeps zero effective quota disabled after the minute changes', () => {
    expect(decide({ now_ms: reset, usage: usage(15), override: { limit_per_minute: 0 } }))
      .toMatchObject({ allowed: false, reason: 'drawing_disabled', used_before: 0, retry_after_seconds: null });
  });
});

describe('invalid data fails closed as a technical error', () => {
  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid pixel count %s', (count) => {
    technicalFailure(() => decide({ pixel_count: count }), 'invalid_pixel_count');
  });
  it.each([-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, Number.MAX_SAFE_INTEGER])('rejects invalid worker time %s', (time) => {
    technicalFailure(() => decide({ now_ms: time }), 'invalid_clock');
  });
  it('rejects the last Firestore minute when its reset instant would be out of range', () => {
    technicalFailure(() => decide({ now_ms: Date.parse('9999-12-31T23:59:59.999Z') }), 'invalid_clock');
  });
  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects malformed stored counters %s, including stale windows', (count) => {
    technicalFailure(() => decide({ usage: usage(count) }), 'invalid_usage');
    technicalFailure(() => decide({ usage: usage(count, start - 60_000) }), 'invalid_usage');
  });
  it('refuses a future window rather than resetting after worker clock rollback', () => {
    technicalFailure(() => decide({ usage: usage(20, reset) }), 'invalid_usage');
  });
  it('refuses an update timestamp ahead of the worker or before the window', () => {
    technicalFailure(() => decide({ usage: usage(20, start, now + 1) }), 'invalid_usage');
    technicalFailure(() => decide({ usage: usage(20, start, start - 1) }), 'invalid_usage');
  });
  it('requires a minute-aligned stored window, not just a valid timestamp', () => {
    technicalFailure(() => decide({ usage: usage(20, start + 1000) }), 'invalid_usage');
    technicalFailure(() => decide({ usage: { ...usage(20), window_start: { seconds: start / 1000, nanoseconds: 1 } } }), 'invalid_usage');
    technicalFailure(() => decide({ usage: usage(20, -60_000) }), 'invalid_usage');
  });
  it.each([
    { seconds: 0.5, nanoseconds: 0 }, { seconds: 0, nanoseconds: -1 },
    { seconds: 0, nanoseconds: 1_000_000_000 }, { seconds: NaN, nanoseconds: 0 },
    null, undefined,
  ].map((value) => ({ value })))('rejects malformed Firestore timestamps $value', ({ value }) => {
    technicalFailure(() => decide({ usage: { ...usage(1), window_start: value as TimestampValue } }), 'invalid_usage');
    technicalFailure(() => decide({ usage: { ...usage(1), updated_at: value as TimestampValue } }), 'invalid_usage');
  });
  it('accepts nanosecond precision on updated_at but keeps the window aligned', () => {
    expect(decide({ usage: { ...usage(1), updated_at: { seconds: start / 1000, nanoseconds: 123 } } }))
      .toMatchObject({ allowed: true, used_before: 1, next_usage: { used_pixels: 2 } });
  });
});

describe('pure proposal, not an independent quota reservation', () => {
  it('does not mutate configuration, timestamps or existing usage', () => {
    const stored = Object.freeze({
      window_start: Object.freeze(stamp(start)), used_pixels: 17, updated_at: Object.freeze(stamp(start)),
    });
    const input = Object.freeze({
      config: Object.freeze({ default_limit_per_minute: 20 }), usage: stored,
      override: Object.freeze({ limit_per_minute: 30 }), now_ms: now, pixel_count: 5,
    });
    const first = evaluateRateLimit(input);
    expect(first).toEqual(evaluateRateLimit(input));
    expect(stored.used_pixels).toBe(17);
    expect(first).toMatchObject({ allowed: true, next_usage: { used_pixels: 22 } });
  });
  it('returns a numeric update proposal, not a counterfeit Firestore Timestamp object', () => {
    const result = decide();
    expect(result.allowed).toBe(true);
    if (result.allowed) {
      expect(result.next_usage).toEqual({ window_start_ms: start, used_pixels: 1, limit_per_minute: 20, updated_at_ms: now });
      expect(result.next_usage).not.toHaveProperty('window_start');
    }
  });
});
