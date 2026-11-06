import { describe, expect, it } from 'vitest';
import { FIRESTORE_DOCUMENT_LIMIT, TILE_PIXELS } from './constants';
import { eventIdToBytes } from './event-order';
import {
  createPixelMetadata,
  estimateMetadataDocumentBytes,
  validatePixelMetadata,
  validateTimestamp,
} from './metadata';
import type { PixelMetadata, TileMetadataDocument, TimestampValue } from './model';

const EVENT_ID = '00112233-4455-6677-8899-aabbccddeeff';
const at = (seconds: number, nanoseconds = 0): TimestampValue => ({ seconds, nanoseconds });
const pixel = (overrides: Partial<PixelMetadata> = {}): PixelMetadata => ({
  uid: '123456789012345678',
  name: 'Benjamin',
  at: at(1_792_000_000, 123_000_000),
  eid: eventIdToBytes(EVENT_ID),
  ...overrides,
});
const metadataDocument = (
  pixels: Record<string, PixelMetadata>,
  overrides: Partial<TileMetadataDocument> = {},
): TileMetadataDocument => ({
  canvas_version: 1,
  tx: 0,
  ty: 0,
  region: '0_0',
  updated_at: at(1_792_000_000),
  pixels,
  ...overrides,
});

describe('validateTimestamp', () => {
  it('accepts the Firestore range and nanosecond precision', () => {
    expect(() => validateTimestamp(at(-62_135_596_800, 999_999_999))).not.toThrow();
    expect(() => validateTimestamp(at(253_402_300_799, 0))).not.toThrow();
  });

  it.each([
    [{ seconds: -62_135_596_801, nanoseconds: 0 }],
    [{ seconds: 253_402_300_800, nanoseconds: 0 }],
    [{ seconds: 0.5, nanoseconds: 0 }],
    [{ seconds: 0, nanoseconds: -1 }],
    [{ seconds: 0, nanoseconds: 1_000_000_000 }],
    [{ seconds: 0, nanoseconds: 1.5 }],
  ])('rejects %o', (value) => {
    expect(() => validateTimestamp(value)).toThrow(RangeError);
  });

  it('enforces millisecond precision only when requested', () => {
    expect(() => validateTimestamp(at(0, 123_000_000), true)).not.toThrow();
    expect(() => validateTimestamp(at(0, 123_000_001), true)).toThrow(/millisecond/);
    expect(() => validateTimestamp(at(0, 123_000_001))).not.toThrow();
  });
});

describe('validatePixelMetadata', () => {
  it('accepts a complete pixel', () => {
    expect(() => validatePixelMetadata(pixel())).not.toThrow();
  });

  it('accepts the maximum 20-digit Discord ID', () => {
    expect(() => validatePixelMetadata(pixel({ uid: '12345678901234567890' }))).not.toThrow();
  });

  it.each(['', '0', '0123', '123456789012345678901', 'abc', ' 123', '-1'])('rejects uid %j', (uid) => {
    expect(() => validatePixelMetadata(pixel({ uid }))).toThrow(/uid/);
  });

  it('accepts 32 code points and up to 128 UTF-8 bytes', () => {
    expect(() => validatePixelMetadata(pixel({ name: 'a'.repeat(32) }))).not.toThrow();
    expect(() => validatePixelMetadata(pixel({ name: '🎨'.repeat(32) }))).not.toThrow();
  });

  it('rejects an empty, too long or too large name', () => {
    expect(() => validatePixelMetadata(pixel({ name: '' }))).toThrow(/name/);
    expect(() => validatePixelMetadata(pixel({ name: 'a'.repeat(33) }))).toThrow(/name/);
    expect(() => validatePixelMetadata(pixel({ name: '🎨'.repeat(33) }))).toThrow(/name/);
  });

  it('rejects an event timestamp with sub-millisecond precision', () => {
    expect(() => validatePixelMetadata(pixel({ at: at(0, 123_000_001) }))).toThrow(/millisecond/);
  });

  it.each([0, 15, 17])('rejects a %i-byte event id', (length) => {
    expect(() => validatePixelMetadata(pixel({ eid: new Uint8Array(length) }))).toThrow(/16 bytes/);
  });
});

describe('createPixelMetadata', () => {
  const timestampFromMillis = (milliseconds: number): TimestampValue => ({
    seconds: Math.floor(milliseconds / 1_000),
    nanoseconds: (milliseconds % 1_000) * 1_000_000,
  });
  const author = { uid: '123456789012345678', name: 'Benjamin' };
  const event = { occurred_at: '2026-10-29T16:30:12.123Z', event_id: EVENT_ID };

  it('converts the event time and identifier', () => {
    expect(createPixelMetadata(author, event, timestampFromMillis)).toEqual({
      ...author,
      at: timestampFromMillis(Date.parse(event.occurred_at)),
      eid: eventIdToBytes(EVENT_ID),
    });
  });

  it('rejects invalid input before returning metadata', () => {
    expect(() => createPixelMetadata(author, { ...event, occurred_at: '2026-10-29T16:30:12Z' }, timestampFromMillis)).toThrow();
    expect(() => createPixelMetadata(author, { ...event, event_id: 'bad' }, timestampFromMillis)).toThrow(/UUID/);
    expect(() => createPixelMetadata({ ...author, name: '' }, event, timestampFromMillis)).toThrow(/name/);
  });
});

describe('estimateMetadataDocumentBytes', () => {
  it('estimates an empty metadata document', () => {
    const size = estimateMetadataDocumentBytes(metadataDocument({}));
    expect(size).toBeGreaterThan(0);
    expect(size).toBeLessThan(200);
  });

  it('validates the tile header', () => {
    expect(() => estimateMetadataDocumentBytes(metadataDocument({}, { canvas_version: 0 }))).toThrow(RangeError);
    expect(() => estimateMetadataDocumentBytes(metadataDocument({}, { tx: 15_625_001 }))).toThrow(RangeError);
    expect(() => estimateMetadataDocumentBytes(metadataDocument({}, { region: '1_0' }))).toThrow(/region/);
    expect(() => estimateMetadataDocumentBytes(metadataDocument({}, { updated_at: at(0, -1) }))).toThrow(RangeError);
  });

  it.each(['01', '1.0', '-1', '4096', '4097'])('rejects the non-canonical pixel index %j', (key) => {
    expect(() => estimateMetadataDocumentBytes(metadataDocument({ [key]: pixel() }))).toThrow();
  });

  it('rejects more pixels than a tile contains', () => {
    const pixels = Object.fromEntries(
      Array.from({ length: TILE_PIXELS + 1 }, (_, index) => [String(index), pixel()]),
    );
    expect(() => estimateMetadataDocumentBytes(metadataDocument(pixels))).toThrow(/Too many/);
  });

  it('keeps the worst-case authored tile under the 1 MiB document limit', () => {
    const worstPixel = pixel({ uid: '12345678901234567890', name: '🎨'.repeat(32) });
    const pixels = Object.fromEntries(
      Array.from({ length: TILE_PIXELS }, (_, index) => [String(index), worstPixel]),
    );
    const size = estimateMetadataDocumentBytes(metadataDocument(pixels));

    expect(size).toBe(928_865);
    expect(size).toBeLessThan(FIRESTORE_DOCUMENT_LIMIT);
  });
});
