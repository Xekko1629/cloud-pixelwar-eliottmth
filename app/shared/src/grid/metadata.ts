import { FIRESTORE_DOCUMENT_LIMIT, TILE_PIXELS, assertCanvasVersion, assertInteger } from './constants';
import { tileId, tileRegionId } from './coordinates';
import { eventIdFromBytes, eventIdToBytes, parseOccurredAt, type EventOrder } from './event-order';
import { COLLECTIONS, type PixelMetadata, type TileMetadataDocument, type TimestampValue } from './model';

const utf8 = new TextEncoder();
const stringSize = (value: string): number => utf8.encode(value).length + 1;

export function validateTimestamp(value: TimestampValue, millisecondsOnly = false): void {
  assertInteger(value.seconds, -62_135_596_800, 253_402_300_799, 'timestamp seconds');
  assertInteger(value.nanoseconds, 0, 999_999_999, 'timestamp nanoseconds');
  if (millisecondsOnly && value.nanoseconds % 1_000_000 !== 0) throw new Error('Event time must have millisecond precision');
}

export function validatePixelMetadata(pixel: PixelMetadata): void {
  if (!/^[1-9]\d{0,19}$/.test(pixel.uid)) throw new Error('uid must be a Discord ID string of at most 20 digits');
  if (!pixel.name || Array.from(pixel.name).length > 32 || utf8.encode(pixel.name).length > 128) throw new Error('Author name must contain 1–32 Unicode code points and at most 128 UTF-8 bytes');
  validateTimestamp(pixel.at, true);
  eventIdFromBytes(pixel.eid);
}

export function createPixelMetadata(
  author: { uid: string; name: string }, event: EventOrder,
  timestampFromMillis: (milliseconds: number) => TimestampValue,
): PixelMetadata {
  const pixel = {
    uid: author.uid,
    name: author.name,
    at: timestampFromMillis(parseOccurredAt(event.occurred_at)),
    eid: eventIdToBytes(event.event_id),
  };
  validatePixelMetadata(pixel);
  return pixel;
}

// Firestore documented stored size, not protobuf/network bytes or JS heap usage.
// Map fields are exempt from indexing. This does not estimate a transaction size.
export function estimateMetadataDocumentBytes(document: TileMetadataDocument): number {
  assertCanvasVersion(document.canvas_version);
  const id = tileId(document.canvas_version, document.tx, document.ty);
  if (document.region !== tileRegionId(document.tx, document.ty)) throw new Error('Tile region does not match its coordinates');
  validateTimestamp(document.updated_at);
  const entries = Object.entries(document.pixels);
  if (entries.length > TILE_PIXELS) throw new Error('Too many pixel entries');
  let pixelsSize = 32;
  for (const [key, pixel] of entries) {
    if (!/^(0|[1-9]\d*)$/.test(key)) throw new Error('Pixel index must be canonical decimal');
    assertInteger(Number(key), 0, TILE_PIXELS - 1, 'pixel index');
    validatePixelMetadata(pixel);
    const fields = stringSize('uid') + stringSize(pixel.uid)
      + stringSize('name') + stringSize(pixel.name)
      + stringSize('at') + 8 + stringSize('eid') + 16;
    pixelsSize += stringSize(key) + 32 + fields;
  }
  const headerSize = stringSize('canvas_version') + 8 + stringSize('tx') + 8
    + stringSize('ty') + 8 + stringSize('region') + stringSize(document.region)
    + stringSize('updated_at') + 8;
  const size = stringSize(COLLECTIONS.metadata) + stringSize(id) + 16 + 32
    + headerSize + stringSize('pixels') + pixelsSize;
  if (size > FIRESTORE_DOCUMENT_LIMIT) throw new Error('Metadata document exceeds Firestore 1 MiB limit');
  return size;
}
