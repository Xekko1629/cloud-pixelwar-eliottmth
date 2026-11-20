import { commandEvent } from '../functions/discord-proxy/src/event';
import { drawInteraction, testApplication } from './discord-proxy-fixtures';

export const commandSubscription = 'projects/demo-pixelwar-test/subscriptions/command-worker';
export const noAdmins = { user_ids: [] as string[], role_ids: [] as string[] };
export function commandFixture(name = 'draw', options: unknown = { x: -1, y: 64, color: 3 }) {
  const original = commandEvent(drawInteraction(), testApplication);
  return { ...original, payload: { ...original.payload, command: name, options } };
}
export function commandPush(event: unknown = commandFixture()) {
  return {
    subscription: commandSubscription,
    message: {
      messageId: '123', data: Buffer.from(JSON.stringify(event)).toString('base64'),
      attributes: { correlation_id: commandFixture().event_id, traceparent: `00-${'1'.repeat(32)}-${'2'.repeat(16)}-00` },
    },
  };
}
