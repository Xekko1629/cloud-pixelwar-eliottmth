import type { DrawCommand, DrawResult } from '@pixelwar/shared/drawing';
import type { DiscordContext, DrawResultEvent } from '@pixelwar/shared/events';
import { stableId } from './message';

/** Id of the result event of a command: stable, so that a redelivery republishes the same event. */
export const resultEventId = (commandId: string): string => stableId('pixelwar:draw-result:v1', commandId);

export function resultEvent(result: DrawResult, command: DrawCommand, correlationId: string, discord?: DiscordContext): DrawResultEvent {
  return {
    schema_version: 1, type: result.type,
    event_id: resultEventId(result.event_id),
    correlation_id: correlationId, occurred_at: result.processed_at, source: result.source,
    actor: { uid: result.uid, name: command.author.name },
    payload: { result, ...(discord ? { discord: { ...discord } } : {}) },
  };
}
