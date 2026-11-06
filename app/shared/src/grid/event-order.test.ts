import { describe, expect, it } from 'vitest';
import {
  canonicalEventId,
  compareEvents,
  eventIdFromBytes,
  eventIdToBytes,
  parseOccurredAt,
} from './event-order';

const LOW_ID = '11111111-1111-4111-8111-111111111111';
const HIGH_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

describe('parseOccurredAt', () => {
  it('accepts the canonical millisecond UTC format', () => {
    expect(parseOccurredAt('2026-10-29T16:30:12.123Z')).toBe(Date.parse('2026-10-29T16:30:12.123Z'));
  });

  it.each([
    ['without milliseconds', '2026-10-29T16:30:12Z'],
    ['with a numeric offset', '2026-10-29T16:30:12.123+00:00'],
    ['with a lowercase separator', '2026-10-29t16:30:12.123z'],
    ['with a space instead of T', '2026-10-29 16:30:12.123Z'],
    ['a non-existent day', '2026-02-30T00:00:00.000Z'],
    ['a non-string date', 'not-a-date'],
    ['a year below the supported range', '0000-01-01T00:00:00.000Z'],
  ])('rejects a timestamp %s', (_label, value) => {
    expect(() => parseOccurredAt(value)).toThrow();
  });
});

describe('event identifiers', () => {
  it('normalises UUIDs to lowercase', () => {
    expect(canonicalEventId('FFFFFFFF-FFFF-4FFF-8FFF-FFFFFFFFFFFF')).toBe(HIGH_ID);
  });

  it('rejects the nil UUID and malformed identifiers', () => {
    expect(() => canonicalEventId('00000000-0000-0000-0000-000000000000')).toThrow(/Nil/);
    for (const value of ['', 'not-a-uuid', LOW_ID.replace('-', ''), `${LOW_ID}0`, 'g1111111-1111-4111-8111-111111111111']) {
      expect(() => canonicalEventId(value)).toThrow(/UUID/);
    }
  });

  it('converts a UUID to 16 bytes and back', () => {
    const bytes = eventIdToBytes('00112233-4455-6677-8899-aabbccddeeff');
    expect(bytes).toEqual(new Uint8Array([0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff]));
    expect(eventIdFromBytes(bytes)).toBe('00112233-4455-6677-8899-aabbccddeeff');
  });

  it('accepts uppercase input when converting to bytes', () => {
    expect(eventIdFromBytes(eventIdToBytes(HIGH_ID.toUpperCase()))).toBe(HIGH_ID);
  });

  it.each([0, 15, 17])('rejects %i stored bytes', (length) => {
    expect(() => eventIdFromBytes(new Uint8Array(length))).toThrow(/16 bytes/);
  });
});

describe('compareEvents', () => {
  const at = (occurred_at: string, event_id: string) => ({ occurred_at, event_id });

  it('orders by occurred_at first', () => {
    const older = at('2026-10-29T16:30:12.123Z', HIGH_ID);
    const newer = at('2026-10-29T16:30:12.124Z', LOW_ID);
    expect(compareEvents(older, newer)).toBe(-1);
    expect(compareEvents(newer, older)).toBe(1);
  });

  it('breaks equal timestamps with the canonical UUID', () => {
    const time = '2026-10-29T16:30:12.123Z';
    expect(compareEvents(at(time, LOW_ID), at(time, HIGH_ID))).toBe(-1);
    expect(compareEvents(at(time, HIGH_ID), at(time, LOW_ID))).toBe(1);
  });

  it('treats case variants of the same event as equal', () => {
    const time = '2026-10-29T16:30:12.123Z';
    expect(compareEvents(at(time, HIGH_ID), at(time, HIGH_ID.toUpperCase()))).toBe(0);
  });

  it('rejects an invalid timestamp or identifier', () => {
    expect(() => compareEvents(at('2026-10-29T16:30:12Z', LOW_ID), at('2026-10-29T16:30:12.123Z', LOW_ID))).toThrow();
    expect(() => compareEvents(at('2026-10-29T16:30:12.123Z', 'bad'), at('2026-10-29T16:30:12.123Z', LOW_ID))).toThrow();
  });
});
