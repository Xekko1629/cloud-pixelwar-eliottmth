import { describe, expect, it } from 'vitest';
import { InvalidDrawRequest, MAX_AUTHOR_NAME, parseDrawBody, webDrawEvent } from './request';

const body = (value: unknown) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
const reason = (action: () => unknown) => {
  try { action(); } catch (error) { return error instanceof InvalidDrawRequest ? error.reason : 'other'; }
  return 'accepted';
};
const identity = { uid: '423456789012345678', name: 'Synthetic user' };

describe('parseDrawBody', () => {
  it('keeps exactly the validated pixels, including the coordinate limits', () => {
    expect(parseDrawBody(body({ pixels: [{ x: 12, y: -40, color: 5 }, { color: 16, x: 1e9, y: -1e9 }] })))
      .toEqual([{ x: 12, y: -40, color: 5 }, { x: 1e9, y: -1e9, color: 16 }]);
  });

  it('caps the batch at the configured maximum', () => {
    const pixels = (count: number) => Array.from({ length: count }, (_, x) => ({ x, y: 0, color: 1 }));
    expect(parseDrawBody(body({ pixels: pixels(500) }))).toHaveLength(500);
    expect(reason(() => parseDrawBody(body({ pixels: pixels(501) })))).toBe('too_many_pixels');
    expect(reason(() => parseDrawBody(body({ pixels: pixels(3) }), 2))).toBe('too_many_pixels');
  });

  it.each([
    ['invalid_json', '{"pixels":'],
    ['invalid_json', Buffer.from([0x7b, 0xff, 0x7d])],
    ['invalid_body', '[]'],
    ['invalid_body', { pixels: [] }],
    ['invalid_body', { pixels: {} }],
    ['invalid_body', { pixels: [{ x: 0, y: 0, color: 1 }], count: 1 }],
    ['invalid_pixel', { pixels: [null] }],
    ['invalid_pixel', { pixels: [{ x: 0, y: 0 }] }],
    ['invalid_pixel', { pixels: [{ x: 0, y: 0, color: 1, name: 'x' }] }],
    ['invalid_pixel', { pixels: [{ x: 0.5, y: 0, color: 1 }] }],
    ['invalid_pixel', { pixels: [{ x: '0', y: 0, color: 1 }] }],
    ['invalid_pixel', { pixels: [{ x: 1e9 + 1, y: 0, color: 1 }] }],
    ['invalid_pixel', { pixels: [{ x: 0, y: -1e9 - 1, color: 1 }] }],
    ['invalid_pixel', { pixels: [{ x: 0, y: 0, color: 0 }] }],
    ['invalid_pixel', { pixels: [{ x: 0, y: 0, color: 17 }] }],
    ['duplicate_pixel', { pixels: [{ x: 3, y: 4, color: 1 }, { x: 3, y: 4, color: 2 }] }],
  ])('refuses %s: %j', (expected, value) => {
    expect(reason(() => parseDrawBody(Buffer.isBuffer(value) ? value : body(value)))).toBe(expected);
  });
});

describe('webDrawEvent', () => {
  it('builds the pixel-draw contract of the event catalogue for the web', () => {
    const event = webDrawEvent([{ x: 1, y: 2, color: 3 }], identity, Date.UTC(2026, 10, 20, 10), () => '11111111-1111-4111-8111-111111111111');
    expect(event).toEqual({
      schema_version: 1, type: 'pixel-draw', event_id: '11111111-1111-4111-8111-111111111111',
      correlation_id: '11111111-1111-4111-8111-111111111111', occurred_at: '2026-11-20T10:00:00.000Z',
      source: 'web', actor: identity, payload: { pixels: [{ x: 1, y: 2, color: 3 }] },
    });
  });

  it('creates a new canonical UUID for every request', () => {
    const first = webDrawEvent([{ x: 1, y: 2, color: 3 }], identity, 0);
    const second = webDrawEvent([{ x: 1, y: 2, color: 3 }], identity, 0);
    expect(first.event_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(second.event_id).not.toBe(first.event_id);
  });

  it('keeps the author name within the DATA-02 limit, by code points', () => {
    const name = '😀'.repeat(MAX_AUTHOR_NAME + 5);
    const event = webDrawEvent([{ x: 1, y: 2, color: 3 }], { ...identity, name }, 0);
    expect(Array.from(event.actor.name)).toHaveLength(MAX_AUTHOR_NAME);
    expect(Buffer.byteLength(event.actor.name)).toBeLessThanOrEqual(128);
  });
});
