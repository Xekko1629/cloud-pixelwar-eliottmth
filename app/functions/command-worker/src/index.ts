import type { HttpFunction } from '@google-cloud/functions-framework';
import { InvalidCommand, MAX_PUSH_BYTES, parsePush, record, snowflake } from './message';
import { createEventPublisher, type PublishEvent } from './publisher';
import { routeCommand, validPermissions, type Permissions } from './route';

interface Options {
  applicationId?: string;
  subscription?: string;
  permissions?: Permissions;
  publish?: PublishEvent;
  write?: (line: string) => void;
}

export function createCommandWorkerHandler(options: Options): HttpFunction {
  const write = options.write ?? ((line: string) => { process.stdout.write(line); });
  // Snapshot authorization configuration; callers cannot mutate it during delivery.
  const permissions = options.permissions && validPermissions(options.permissions)
    ? { user_ids: [...options.permissions.user_ids], role_ids: [...options.permissions.role_ids] } : undefined;
  return async (req, res): Promise<void> => {
    if (!snowflake(options.applicationId) || !options.subscription ||
        !/^projects\/[a-z][a-z0-9-]+\/subscriptions\/[a-zA-Z][a-zA-Z0-9._~+%-]{2,254}$/.test(options.subscription) ||
        !options.publish || !permissions) {
      res.status(503).json({ error: 'Command worker unavailable.' }); return;
    }
    if (req.path !== '/') { res.status(404).json({ error: 'Not found.' }); return; }
    if (req.method !== 'POST') { res.set('Allow', 'POST').status(405).json({ error: 'Method not allowed.' }); return; }
    if (!Buffer.isBuffer(req.rawBody) || req.rawBody.length > MAX_PUSH_BYTES) {
      res.status(413).json({ error: 'Invalid push body size.' }); return;
    }
    try {
      const { command, attributes, message_id } = parsePush(req.body, options.subscription, options.applicationId);
      const event = routeCommand(command, permissions);
      await options.publish(event, attributes);
      write(`${JSON.stringify({
        severity: event.type === 'command-rejected' ? 'WARNING' : 'INFO',
        function: 'command-worker', event_type: 'discord.command.routed',
        event_id: event.event_id, correlation_id: event.correlation_id, message_id, output_type: event.type,
      })}\n`);
    } catch (error) {
      try {
        write(`${JSON.stringify({ severity: 'WARNING', function: 'command-worker',
          event_type: error instanceof InvalidCommand ? 'discord.command.invalid' : 'discord.command.failed',
          ...(error instanceof InvalidCommand ? { reason: error.reason } : {}),
        })}\n`);
      } catch { /* Logging failure must never expose the Error or acknowledge an unconfirmed operation. */ }
      res.status(error instanceof InvalidCommand ? 400 : 503).json({ error: 'Command processing unavailable.' }); return;
    }
    res.status(204).send();
  };
}

function permissionsFromEnvironment(value: string | undefined): Permissions | undefined {
  try {
    const parsed: unknown = JSON.parse(value ?? '');
    if (record(parsed) && Object.keys(parsed).sort().join(',') === 'role_ids,user_ids' &&
        validPermissions(parsed as unknown as Permissions)) return parsed as unknown as Permissions;
  } catch { /* Never expose secret configuration values. */ }
  return undefined;
}

export const handleCommandWorker = createCommandWorkerHandler({
  applicationId: process.env.DISCORD_APPLICATION_ID, subscription: process.env.DISCORD_COMMAND_SUBSCRIPTION,
  permissions: permissionsFromEnvironment(process.env.DISCORD_ADMIN_ALLOWLIST),
  publish: process.env.GOOGLE_CLOUD_PROJECT ? createEventPublisher(process.env.GOOGLE_CLOUD_PROJECT, {
    'pixel-draw': process.env.PIXEL_DRAW_TOPIC, 'render-requested': process.env.RENDER_REQUESTED_TOPIC,
    'snapshot-requested': process.env.SNAPSHOT_REQUESTED_TOPIC, 'admin-requested': process.env.ADMIN_REQUESTED_TOPIC,
    'command-rejected': process.env.COMMAND_REJECTED_TOPIC,
  }) : undefined,
});
