import { afterEach, describe, expect, it, vi } from 'vitest';
import { notificationEvent, notifierNow, notifierPush, notifierSubscriptions } from '../../../testing/discord-notifier-fixtures';
import { testApplication, testNow } from '../../../testing/discord-proxy-fixtures';
import { parseNoticePush, TOKEN_LIFETIME_MS, type DiscordNotice } from './message';
import { createOriginalResponseUpdater, NotificationFailure } from './discord';
import { UNKNOWN_INTERACTION_AFTER_MS } from '@pixelwar/shared/discord';

const notice = (): DiscordNotice => {
  const parsed = parseNoticePush(notifierPush(), notifierSubscriptions, testApplication);
  if (parsed.source !== 'discord') throw new Error('Fixture must be Discord');
  return parsed;
};
afterEach(() => { vi.restoreAllMocks(); });

describe('original interaction response updater', () => {
  it('PATCHes the original message, suppresses mentions and never reads the returned content', async () => {
    const response = new Response('synthetic-interaction-token', { status: 200 });
    const text = vi.spyOn(response, 'text'); const json = vi.spyOn(response, 'json');
    const cancel = vi.spyOn(response.body!, 'cancel');
    const request = vi.fn<typeof fetch>().mockResolvedValue(response);
    const update = createOriginalResponseUpdater({ fetch: request, now: () => notifierNow });
    expect(await update(notice())).toBe('updated');
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0]).toBe(`https://discord.com/api/v10/webhooks/${testApplication}/synthetic-interaction-token/messages/@original`);
    const options = request.mock.calls[0][1]!;
    expect(options).toMatchObject({ method: 'PATCH', redirect: 'error', headers: { 'Content-Type': 'application/json' } });
    expect(JSON.parse(String(options.body))).toMatchObject({ allowed_mentions: { parse: [] }, embeds: [], components: [] });
    expect(JSON.stringify(options.headers)).not.toMatch(/Authorization|Bot /);
    expect(cancel).toHaveBeenCalled(); expect(text).not.toHaveBeenCalled(); expect(json).not.toHaveBeenCalled();
  });
  it('retries and duplicates overwrite with identical content, never POST a second message', async () => {
    const request = vi.fn<typeof fetch>().mockImplementation(async () => new Response(null, { status: 200 }));
    const update = createOriginalResponseUpdater({ fetch: request, now: () => notifierNow });
    await update(notice()); await update(notice());
    expect(request.mock.calls[0][0]).toEqual(request.mock.calls[1][0]);
    expect(request.mock.calls[0][1]!.body).toEqual(request.mock.calls[1][1]!.body);
    expect(request.mock.calls.every((call) => call[1]?.method === 'PATCH')).toBe(true);
  });
  it('uses the same safe client when global fetch is selected', async () => {
    const request = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 200 }));
    expect(await createOriginalResponseUpdater({ now: () => notifierNow })(notice())).toBe('updated');
    expect(request).toHaveBeenCalledTimes(1);
  });
  it.each([0, 1, 60_000])('does not make any request at or after expiry (+%s ms)', async (extra) => {
    const request = vi.fn<typeof fetch>();
    const update = createOriginalResponseUpdater({ fetch: request, now: () => testNow + TOKEN_LIFETIME_MS + extra });
    expect(await update(notice())).toBe('expired'); expect(request).not.toHaveBeenCalled();
  });
  it('still tries at the last millisecond, with a bounded abort signal', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 200 }));
    const update = createOriginalResponseUpdater({ fetch: request, now: () => testNow + TOKEN_LIFETIME_MS - 1 });
    expect(await update(notice())).toBe('updated');
    expect(request.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
  });
  it('reports an unknown interaction (404) instead of a retryable failure, without leaking its body', async () => {
    // Discord answers 404 Unknown Webhook when the deferred response was never acknowledged
    // (proxy cold start beyond 3 s): a retry could never edit that message.
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response('synthetic-interaction-token', { status: 404 }));
    const update = createOriginalResponseUpdater({ fetch: request, now: () => testNow + UNKNOWN_INTERACTION_AFTER_MS });
    expect(await update(notice())).toBe('unknown_interaction');
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('keeps a 404 retryable while the deferred answer may not be stored yet', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 404 }));
    const update = createOriginalResponseUpdater({ fetch: request, now: () => testNow + UNKNOWN_INTERACTION_AFTER_MS - 1 });
    await expect(update(notice())).rejects.toMatchObject({ reason: 'http', status: 404 });
  });
  it.each([400, 401, 403, 429, 500, 503])('keeps non-success status %s retryable before expiry without leaking its body', async (status) => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response('synthetic-interaction-token', { status }));
    const update = createOriginalResponseUpdater({ fetch: request, now: () => notifierNow });
    try { await update(notice()); throw new Error('Expected failure'); }
    catch (error) {
      expect(error).toBeInstanceOf(NotificationFailure);
      expect(error).toMatchObject({ status, reason: status === 429 ? 'rate_limited' : 'http' });
      expect(String(error)).not.toContain('synthetic-interaction-token');
      expect(JSON.stringify(error)).not.toContain('synthetic-interaction-token');
    }
  });
  it.each([['2.5', 3], ['99999', 900], ['0', undefined], ['bad', undefined]])('sanitizes Retry-After %s', async (header, expected) => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 429, headers: { 'Retry-After': String(header) } }));
    await expect(createOriginalResponseUpdater({ fetch: request, now: () => notifierNow })(notice())).rejects.toMatchObject({ retryAfterSeconds: expected });
  });
  it('redacts request URLs/errors thrown by fetch, including redirects or timeouts', async () => {
    const request = vi.fn<typeof fetch>().mockRejectedValue(new Error('https://discord.com/webhooks/synthetic-interaction-token'));
    await expect(createOriginalResponseUpdater({ fetch: request, now: () => notifierNow })(notice())).rejects.toMatchObject({ reason: 'network', message: 'Discord notification unavailable.' });
  });
  it.each([true, false])('stops retrying if the token expires during a failed request (network failure: %s)', async (network) => {
    let now = notifierNow;
    const request = vi.fn<typeof fetch>().mockImplementation(async () => {
      now = testNow + TOKEN_LIFETIME_MS;
      if (network) throw new Error('synthetic-interaction-token');
      return new Response(null, { status: 503 });
    });
    expect(await createOriginalResponseUpdater({ fetch: request, now: () => now })(notice())).toBe('expired');
  });
  it('does not turn a confirmed successful PATCH into a failure if body cancellation fails', async () => {
    const response = new Response('synthetic-interaction-token', { status: 200 });
    vi.spyOn(response.body!, 'cancel').mockRejectedValue(new Error('synthetic-interaction-token'));
    const request = vi.fn<typeof fetch>().mockResolvedValue(response);
    expect(await createOriginalResponseUpdater({ fetch: request, now: () => notifierNow })(notice())).toBe('updated');
  });
  it('escapes the token as one path segment and never accepts a destination URL from an event', async () => {
    const event = notificationEvent(); event.payload.discord!.interaction_token = 'synthetic/token?query#fragment';
    const parsed = parseNoticePush(notifierPush(event), notifierSubscriptions, testApplication) as DiscordNotice;
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 200 }));
    await createOriginalResponseUpdater({ fetch: request, now: () => notifierNow })(parsed);
    expect(String(request.mock.calls[0][0])).toContain('/synthetic%2Ftoken%3Fquery%23fragment/messages/@original');
  });
  it.each([-1, NaN, Infinity, testNow - 5001])('fails closed on an invalid or inconsistent clock %s', async (now) => {
    const request = vi.fn<typeof fetch>();
    await expect(createOriginalResponseUpdater({ fetch: request, now: () => now })(notice())).rejects.toMatchObject({ reason: 'invalid_clock' });
    expect(request).not.toHaveBeenCalled();
  });
  it.each([0, -1, 1.5, 10_001])('rejects an unbounded/invalid timeout %s', (timeoutMs) => {
    expect(() => createOriginalResponseUpdater({ timeoutMs })).toThrow('timeout');
  });
});
