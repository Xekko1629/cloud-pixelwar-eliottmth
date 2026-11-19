import type { DrawCommand, DrawResult } from '@pixelwar/shared/drawing';
import type { PixelDrawEvent } from '@pixelwar/shared/events';
import { parsePush } from '../functions/command-worker/src/message';
import { routeCommand } from '../functions/command-worker/src/route';
import { commandPush, commandSubscription, noAdmins } from './command-worker-fixtures';
import { testApplication } from './discord-proxy-fixtures';

export const drawNow = Date.parse('2026-11-19T10:00:30.000Z');
export const drawSubscription = 'projects/demo-pixelwar-test/subscriptions/draw-worker';
export function webDrawEvent(): PixelDrawEvent {
  return {
    schema_version: 1, type: 'pixel-draw', event_id: '11111111-1111-4111-8111-111111111111',
    correlation_id: '22222222-2222-4222-8222-222222222222', occurred_at: new Date(drawNow).toISOString(),
    source: 'web', actor: { uid: '423456789012345678', name: 'Synthetic user' },
    payload: { pixels: [{ x: 0, y: 0, color: 2 }] },
  };
}
export function discordDrawEvent(): PixelDrawEvent {
  const parsed = parsePush(commandPush(), commandSubscription, testApplication);
  const event = routeCommand(parsed.command, noAdmins);
  if (event.type !== 'pixel-draw') throw new Error('Test fixture must route a draw');
  return event;
}
export function drawPush(event: unknown = webDrawEvent()) {
  return {
    subscription: drawSubscription,
    message: { messageId: '123', data: Buffer.from(JSON.stringify(event)).toString('base64'), attributes: {
      correlation_id: (event as PixelDrawEvent | null)?.correlation_id ?? webDrawEvent().correlation_id,
      traceparent: `00-${'1'.repeat(32)}-${'2'.repeat(16)}-00`,
    } },
  };
}
export function processedResult(command: DrawCommand): DrawResult {
  return {
    schema_version: 1, result_id: `draw-result:${command.event_id}`, event_id: command.event_id,
    occurred_at: command.occurred_at, processed_at: new Date(drawNow).toISOString(), source: command.source,
    uid: command.author.uid, canvas_version: 1, type: 'pixel-processed', requested_pixels: command.pixels.length,
    applied_pixels: command.pixels.length, ignored_pixels: 0, regions: ['0_0'],
  };
}
