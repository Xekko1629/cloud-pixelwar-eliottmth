import { expect, it } from 'vitest';
import { discordDrawEvent, drawPush, drawSubscription, processedResult } from '../../../testing/draw-worker-fixtures';
import { testApplication } from '../../../testing/discord-proxy-fixtures';
import { parseDrawPush } from './message';
import { resultEvent } from './result';

it('uses a distinct stable result ID and the stored processing date, not delivery time', () => {
  const parsed = parseDrawPush(drawPush(), drawSubscription);
  const result = processedResult(parsed.command);
  const first = resultEvent(result, parsed.command, parsed.attributes.correlation_id);
  expect(first).toEqual(resultEvent(result, parsed.command, parsed.attributes.correlation_id));
  expect(first.event_id).toMatch(/^[0-9a-f-]{14}8[0-9a-f-]+$/);
  expect(first.event_id).not.toBe(parsed.command.event_id);
  expect(first.occurred_at).toBe(result.processed_at);
  expect(first.payload.result).toEqual(result);
  expect(first.payload.discord).toBeUndefined();
});
it('preserves the sensitive context only in the notification payload, not the engine command', () => {
  const parsed = parseDrawPush(drawPush(discordDrawEvent()), drawSubscription, testApplication);
  const first = resultEvent(processedResult(parsed.command), parsed.command, parsed.attributes.correlation_id, parsed.discord);
  expect(first.payload.discord?.interaction_token).toBe('synthetic-interaction-token');
  parsed.discord!.interaction_token = 'changed';
  expect(first.payload.discord?.interaction_token).toBe('synthetic-interaction-token');
});
