import type { DrawResult } from '@pixelwar/shared/drawing';
import type { DrawResultEvent } from '@pixelwar/shared/events';
import { parseDrawPush } from '../functions/draw-worker/src/message';
import { resultEvent } from '../functions/draw-worker/src/result';
import { discordDrawEvent, drawPush, drawSubscription, processedResult, webDrawEvent } from './draw-worker-fixtures';
import { testApplication, testNow } from './discord-proxy-fixtures';

export const notifierNow = testNow + 2000;
export const notifierSubscriptions = {
  'pixel-processed': 'projects/demo-pixelwar-test/subscriptions/discord-processed',
  'pixel-rejected': 'projects/demo-pixelwar-test/subscriptions/discord-rejected',
};
export function notificationEvent(type: DrawResultEvent['type'] = 'pixel-processed', source: 'web' | 'discord' = 'discord', reason: DrawResult['reason'] = 'paused') {
  const input = source === 'discord' ? discordDrawEvent() : webDrawEvent();
  const parsed = parseDrawPush(drawPush(input), drawSubscription, testApplication);
  let result: DrawResult = { ...processedResult(parsed.command), processed_at: new Date(Date.parse(parsed.command.occurred_at) + 1000).toISOString() };
  if (type === 'pixel-rejected') result = { ...result, type, reason, applied_pixels: 0, ignored_pixels: 0, regions: [] };
  return resultEvent(result, parsed.command, parsed.attributes.correlation_id, parsed.discord);
}
export function notifierPush(event: unknown = notificationEvent()) {
  const typed = event as DrawResultEvent | null;
  return { subscription: notifierSubscriptions[typed?.type === 'pixel-rejected' ? 'pixel-rejected' : 'pixel-processed'],
    message: { messageId: '123', data: Buffer.from(JSON.stringify(event)).toString('base64'), attributes: {
      correlation_id: typed?.correlation_id ?? notificationEvent().correlation_id,
      traceparent: `00-${'1'.repeat(32)}-${'2'.repeat(16)}-00`,
    } },
  };
}
