import { Timestamp } from '@google-cloud/firestore';
import {
  compareEvents, emptyTileColors, estimateMetadataDocumentBytes, eventIdFromBytes, locatePixel,
  tileRegionId, validateTileColors, validateTimestamp,
  type TileColorsDocument, type TileMetadataDocument, type DrawPixel,
} from '../grid';
import { DrawProcessingError, firestorePixel, type PreparedDraw } from './command';

export interface TileChange {
  id: string;
  tx: number;
  ty: number;
  pixels: DrawPixel[];
  colors?: TileColorsDocument;
  metadata?: TileMetadataDocument;
}

/** Computes complete replacement documents; never mutates snapshots or writes. */
export function planTileChanges(tile: TileChange, command: PreparedDraw, version: number, now: number) {
  const header = { canvas_version: version, tx: tile.tx, ty: tile.ty, region: tileRegionId(tile.tx, tile.ty) };
  let oldColors = emptyTileColors();
  let oldPixels: TileMetadataDocument['pixels'] = {};
  try {
    if (Boolean(tile.colors) !== Boolean(tile.metadata)) throw new Error('Unpaired tile documents');
    if (tile.colors && tile.metadata) {
      for (const document of [tile.colors, tile.metadata]) {
        if (document.canvas_version !== version || document.tx !== tile.tx || document.ty !== tile.ty || document.region !== header.region) {
          throw new Error('Inconsistent tile header');
        }
        validateTimestamp(document.updated_at);
      }
      validateTileColors(tile.colors.colors);
      estimateMetadataDocumentBytes(tile.metadata);
      oldColors = tile.colors.colors;
      oldPixels = tile.metadata.pixels;
      for (let index = 0; index < oldColors.length; index++) {
        if ((oldColors[index] !== 0) !== Object.hasOwn(oldPixels, String(index))) throw new Error('Missing pixel provenance');
      }
    }
  } catch {
    throw new DrawProcessingError('invalid_state', 'Corrupt tile or missing pixel provenance');
  }
  // Firestore returns Buffer values: Buffer.slice() would share snapshot memory.
  const colors = Uint8Array.from(oldColors);
  const pixels = { ...oldPixels };
  const applied: DrawPixel[] = [];
  const author = firestorePixel(command.metadata);
  for (const pixel of tile.pixels) {
    const index = locatePixel(pixel.x, pixel.y).index;
    const previous = pixels[String(index)];
    if (previous && compareEvents(command, {
      event_id: eventIdFromBytes(previous.eid),
      occurred_at: new Date(previous.at.seconds * 1000 + previous.at.nanoseconds / 1_000_000).toISOString(),
    }) <= 0) continue;
    colors[index] = pixel.color;
    pixels[String(index)] = author;
    applied.push(pixel);
  }
  const updated_at = Timestamp.fromMillis(now);
  const metadata: TileMetadataDocument = { ...header, updated_at, pixels };
  const metadataBytes = estimateMetadataDocumentBytes(metadata);
  return {
    applied,
    colors: { ...header, updated_at, colors: Buffer.from(colors) },
    metadata,
    // Conservative stored-data estimate, not an exact protobuf/index request size.
    estimated_bytes: metadataBytes + colors.byteLength + 1024,
  };
}
