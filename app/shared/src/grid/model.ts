import type { Bounds, GridSize } from './coordinates';

// Structural contract shared by the SDK adapters. Do not write a plain object
// as a Firestore Timestamp: adapters must supply the actual SDK Timestamp type.
export interface TimestampValue { readonly seconds: number; readonly nanoseconds: number }
export interface PixelMetadata {
  uid: string;
  name: string;
  at: TimestampValue;
  eid: Uint8Array;
}
export interface TileHeader {
  canvas_version: number;
  tx: number;
  ty: number;
  region: string;
  updated_at: TimestampValue;
}
export interface TileColorsDocument extends TileHeader { colors: Uint8Array }
export interface TileMetadataDocument extends TileHeader { pixels: Record<string, PixelMetadata> }
export interface DeltaDocument {
  encoding_version: 1;
  canvas_version: number;
  region: string;
  event_id: string;
  created_at: TimestampValue;
  expire_at: TimestampValue;
  pixels: Uint8Array;
}
export interface GlobalConfigDocument {
  paused: boolean;
  canvas_version: number;
  size: GridSize | null;
  bounds: Bounds | null;
  // Explicitly initialize to 20; a missing/invalid value is a technical failure.
  default_limit_per_minute: number;
}

// DATA-03 usage contract; persisted atomically with drawing/deduplication in DATA-02.
export interface UserStateDocument {
  window_start: TimestampValue;
  used_pixels: number;
  // Informational snapshot, not the source of the current effective limit.
  limit_per_minute: number;
  last_rejection: { event_id: string; reason: string; at: TimestampValue } | null;
  updated_at: TimestampValue;
}
export interface RateLimitOverrideDocument { limit_per_minute: number; updated_at: TimestampValue }
export interface ProcessedEventDocument {
  canvas_version: number;
  event_id: string;
  status: 'processed' | 'rejected';
  created_at: TimestampValue;
  expire_at: TimestampValue;
}

export const COLLECTIONS = Object.freeze({
  colors: 'tile_colors', metadata: 'tile_metadata', deltas: 'deltas',
  config: 'config', users: 'users', overrides: 'ratelimit_overrides', processed: 'processed_events',
});
