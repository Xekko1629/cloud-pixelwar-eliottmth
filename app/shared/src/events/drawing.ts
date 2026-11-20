import type { DrawResult } from '../drawing';
import type { DrawPixel } from '../grid';
import type { DiscordContext } from './discord';

interface DrawEnvelope {
  schema_version: 1;
  type: 'pixel-draw';
  event_id: string;
  correlation_id: string;
  occurred_at: string;
  actor: { uid: string; name: string };
}
export type PixelDrawEvent = DrawEnvelope & (
  | { source: 'discord'; payload: { pixels: readonly DrawPixel[]; discord: DiscordContext } }
  | { source: 'web'; payload: { pixels: readonly DrawPixel[] } }
);

/** Proposed ARCH-03 result contract, shared by draw-worker and future consumers. */
export interface DrawResultEvent {
  schema_version: 1;
  type: 'pixel-processed' | 'pixel-rejected';
  event_id: string;
  correlation_id: string;
  occurred_at: string;
  source: 'web' | 'discord';
  actor: { uid: string; name: string };
  payload: { result: DrawResult; discord?: DiscordContext };
}
