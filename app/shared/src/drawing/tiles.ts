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

export interface PlanOptions {
  /** The documents come from a previous plan of this same transaction: already validated. */
  trusted?: boolean;
  /** false: estimated_bytes is 0, the caller calls estimateTileBytes once after its last plan. */
  estimate?: boolean;
}

/**
 * Stored-size estimate of a planned tile. It walks every pixel entry of the metadata
 * (about 30 ms for a full tile of 4,096 pixels, dev machine, 28/11): a group calls it once
 * per tile, not once per command.
 */
export function estimateTileBytes(metadata: TileMetadataDocument, colors: Uint8Array): number {
  // Conservative stored-data estimate, not an exact protobuf/index request size.
  return estimateMetadataDocumentBytes(metadata) + colors.byteLength + 1024;
}

/** Computes complete replacement documents; never mutates snapshots or writes. */
export function planTileChanges(tile: TileChange, command: PreparedDraw, version: number, now: number, options: PlanOptions = {}) {
  const header = { canvas_version: version, tx: tile.tx, ty: tile.ty, region: tileRegionId(tile.tx, tile.ty) };
  let oldColors = emptyTileColors();
  let oldPixels: TileMetadataDocument['pixels'] = {};
  if (options.trusted && tile.colors && tile.metadata) {
    oldColors = tile.colors.colors;
    oldPixels = tile.metadata.pixels;
  } else try {
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
  return {
    applied,
    colors: { ...header, updated_at, colors: Buffer.from(colors) },
    metadata,
    estimated_bytes: options.estimate === false ? 0 : estimateTileBytes(metadata, colors),
  };
}
