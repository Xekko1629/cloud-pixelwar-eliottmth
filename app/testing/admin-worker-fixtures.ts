import type { RoutedDiscordEvent } from '@pixelwar/shared/events';
import { parsePush } from '../functions/command-worker/src/message';
import { routeCommand, type Permissions } from '../functions/command-worker/src/route';
import { commandFixture, commandPush, commandSubscription } from './command-worker-fixtures';
import { testApplication } from './discord-proxy-fixtures';

// Events produced by the real BOT-04 router, so that consumers are tested against its contract.
export const adminUid = '423456789012345678';
export const adminRole = '523456789012345678';
export const admins: Permissions = { user_ids: [adminUid], role_ids: [] };
export const adminSubscription = 'projects/demo-pixelwar-test/subscriptions/admin-worker';
export const commandRejectedSubscription = 'projects/demo-pixelwar-test/subscriptions/discord-command-rejected';

export function routedCommand(name: string, options: unknown, permissions: Permissions = admins): RoutedDiscordEvent {
  const input = parsePush(commandPush(commandFixture(name, options)), commandSubscription, testApplication).command;
  return routeCommand(input, permissions);
}

export function eventPush(event: unknown, subscription: string, correlationId?: string) {
  const typed = event as { correlation_id?: string } | null;
  return {
    subscription,
    message: {
      messageId: '456', data: Buffer.from(JSON.stringify(event)).toString('base64'),
      attributes: { correlation_id: correlationId ?? typed?.correlation_id ?? '', traceparent: `00-${'1'.repeat(32)}-${'2'.repeat(16)}-01` },
    },
  };
}
