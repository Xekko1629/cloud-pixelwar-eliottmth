import { describe, expect, it, vi } from 'vitest';
import { sendStrokes, strokePixels, validateSettings, type SendSettings } from './send';

const token = 'synthetic-session-token';
const settings = (changes: Partial<SendSettings> = {}): SendSettings => ({
  baseUrl: 'https://gateway.example.test/', token, strokes: 2, pixels: 3, x: 15_000, y: 15_000, ...changes,
});
const answer = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

describe('strokePixels', () => {
  it('places unique pixels in rows of 100, one block of 10 rows per stroke', () => {
    const pixels = strokePixels(1, 500, 10, 20);
    expect(new Set(pixels.map((p) => `${p.x},${p.y}`)).size).toBe(500);
    expect(pixels[0]).toEqual({ x: 10, y: 30, color: 2 });
    expect(pixels[499]).toEqual({ x: 109, y: 34, color: 1 + (500 % 16) });
    expect(pixels.every((p) => p.color >= 1 && p.color <= 16)).toBe(true);
  });
});

describe('validateSettings', () => {
  it.each([
    [{ baseUrl: 'http://gateway.example.test' }, 'https'], [{ baseUrl: 'not a url' }, 'https'],
    [{ token: '' }, 'PIXELWAR_SESSION_TOKEN'], [{ strokes: 0 }, '--strokes'], [{ strokes: 11 }, '--strokes'],
    [{ pixels: 501 }, '--pixels'], [{ pixels: Number.NaN }, '--pixels'], [{ x: 1.5 }, '--x'],
  ])('refuses %j', (changes, message) => {
    expect(() => validateSettings(settings(changes))).toThrow(message);
  });
});

describe('sendStrokes', () => {
  it('sends every stroke through the gateway with the session and keeps the published ids', async () => {
    const fetch = vi.fn(async () => answer(202, { correlation_id: 'c', event_ids: ['a', 'b', 'c'] }));
    let clock = 1_000;
    const run = await sendStrokes(settings(), fetch as unknown as typeof globalThis.fetch, () => (clock += 5));
    expect(fetch).toHaveBeenCalledTimes(2);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://gateway.example.test/api/pixels');
    expect(init.headers).toMatchObject({ Authorization: `Bearer ${token}` });
    expect(JSON.parse(init.body as string).pixels).toHaveLength(3);
    expect(run.results.map((r) => [r.status, r.event_ids.length, r.correlation_id])).toEqual([[202, 3, 'c'], [202, 3, 'c']]);
    expect(run).toMatchObject({ schema_version: 1, strokes: 2, pixels_per_stroke: 3, origin: { x: 15_000, y: 15_000 } });
    expect(JSON.stringify(run)).not.toContain(token);
  });
  it('keeps only a fixed error code for a refusal, a strange answer or a network failure', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(answer(429, { error: 'rate_limited' }))
      .mockResolvedValueOnce(answer(500, { error: `Bearer ${token}` }))
      .mockResolvedValueOnce(new Response('<html>', { status: 502 }))
      .mockRejectedValueOnce(new Error(token));
    const run = await sendStrokes(settings({ strokes: 4 }), fetch);
    expect(run.results.map((r) => [r.status, r.error])).toEqual([
      [429, 'rate_limited'], [500, 'unexpected_response'], [502, 'unexpected_response'], [0, 'network_error'],
    ]);
    expect(JSON.stringify(run)).not.toContain(token);
  });
  it('tolerates an accepted answer without ids', async () => {
    const run = await sendStrokes(settings({ strokes: 1 }), vi.fn(async () => answer(202, { event_ids: [1, 'x'] })));
    expect(run.results[0]).toMatchObject({ status: 202, event_ids: ['x'] });
    expect(run.results[0].correlation_id).toBeUndefined();
  });
  it('validates before any request', async () => {
    const fetch = vi.fn();
    await expect(sendStrokes(settings({ token: '' }), fetch)).rejects.toThrow('PIXELWAR_SESSION_TOKEN');
    expect(fetch).not.toHaveBeenCalled();
  });
});
