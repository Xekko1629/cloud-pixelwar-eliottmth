import type { DrawCommand, DrawResult } from '@pixelwar/shared/drawing';
import type { DiscordContext, DrawResultEvent } from '@pixelwar/shared/events';
import { stableId } from './message';

export function resultEvent(result: DrawResult, command: DrawCommand, correlationId: string, discord?: DiscordContext): DrawResultEvent {
  return {
    schema_version: 1, type: result.type,
    event_id: stableId('pixelwar:draw-result:v1', result.event_id),
    correlation_id: correlationId, occurred_at: result.processed_at, source: result.source,
    actor: { uid: result.uid, name: command.author.name },
    payload: { result, ...(discord ? { discord: { ...discord } } : {}) },
  };
}
