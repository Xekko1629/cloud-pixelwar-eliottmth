import type { RoutedDiscordEvent } from '@pixelwar/shared/events';
import { snowflake, type IncomingCommand } from './message';

export type { OutputType } from '@pixelwar/shared/events';
export type RoutedEvent = RoutedDiscordEvent;
export interface Permissions { user_ids: readonly string[]; role_ids: readonly string[] }

export function validPermissions(value: Permissions): boolean {
  return Array.isArray(value?.user_ids) && value.user_ids.every(snowflake) &&
    Array.isArray(value?.role_ids) && value.role_ids.every(snowflake);
}

/** No storage/network side effects. Never rely on Discord's command visibility. */
export function routeCommand(input: IncomingCommand, permissions: Permissions): RoutedEvent {
  if (!validPermissions(permissions)) throw new Error('Invalid authorization configuration');
  const envelope = {
    schema_version: 1 as const, event_id: input.event_id, correlation_id: input.correlation_id,
    occurred_at: input.occurred_at, source: 'discord' as const, actor: { uid: input.actor.uid, name: input.actor.name },
  };
  const { command } = input;
  const discord = { ...input.discord };
  // Restrictive snapshot policy, consistent with BOT-02 until the brief is clarified.
  if ((command.command === 'admin' || command.command === 'snapshot') &&
      !permissions.user_ids.includes(input.actor.uid) && !input.actor.roles.some((role) => permissions.role_ids.includes(role))) {
    return { ...envelope, type: 'command-rejected', payload: { command: command.command, reason: 'unauthorized', discord } };
  }
  switch (command.command) {
    case 'draw': return { ...envelope, type: 'pixel-draw', payload: { pixels: [{ ...command.options }], discord } };
    case 'get': return { ...envelope, type: 'render-requested', payload: { discord } };
    case 'snapshot': return { ...envelope, type: 'snapshot-requested', payload: { discord } };
    case 'admin': return { ...envelope, type: 'admin-requested', payload: { options: { ...command.options }, discord } };
  }
}
