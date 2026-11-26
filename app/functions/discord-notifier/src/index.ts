import type { HttpFunction } from '@google-cloud/functions-framework';
import { createFunctionTelemetry, type FunctionTelemetry } from '@pixelwar/shared/observability/function';
import { createOriginalResponseUpdater, NotificationFailure, type UpdateOriginal } from './discord';
import { InvalidNotice, MAX_PUSH_BYTES, parseNoticePush, snowflake, validSubscriptions, type Subscriptions } from './message';
import { answerHealth } from '@pixelwar/shared/health';

interface Options {
  applicationId?: string;
  subscriptions?: Subscriptions;
  update?: UpdateOriginal;
  write?: (line: string) => void;
  telemetry?: FunctionTelemetry;
}
export function createDiscordNotifierHandler(options: Options): HttpFunction {
  const write = options.write ?? ((line: string) => { process.stdout.write(line); });
  const telemetry = options.telemetry ?? createFunctionTelemetry('discord-notifier', { writeLog: write });
  const subscriptions = validSubscriptions(options.subscriptions) ? { ...options.subscriptions } : undefined;
  return async (req, res): Promise<void> => {
    // Warmer (ADR-0017): before any configuration check, without log or side effect.
    if (answerHealth(req, res)) return;
    if (!snowflake(options.applicationId) || !subscriptions || !options.update) {
      res.status(503).json({ error: 'Discord notifier unavailable.' }); return;
    }
    if (req.path !== '/') { res.status(404).json({ error: 'Not found.' }); return; }
    if (req.method !== 'POST') { res.set('Allow', 'POST').status(405).json({ error: 'Method not allowed.' }); return; }
    if (!Buffer.isBuffer(req.rawBody) || req.rawBody.length > MAX_PUSH_BYTES) {
      res.status(413).json({ error: 'Invalid push body size.' }); return;
    }
    let identifiers: { event_id: string; correlation_id: string; message_id: string } | undefined;
    try {
      const notice = parseNoticePush(req.body, subscriptions, options.applicationId);
      identifiers = { event_id: notice.event_id, correlation_id: notice.correlation_id, message_id: notice.message_id };
      await telemetry.message(notice.result.type, notice.attributes, async (operation) => {
        operation.source(notice.source);
        if (notice.source === 'discord') operation.notificationAge(notice.discord.created_at);
        let outcome: 'skipped_web' | 'updated' | 'expired' | 'unknown_interaction';
        try { outcome = notice.source === 'web' ? 'skipped_web' : await options.update!(notice); }
        catch (error) { if (error instanceof NotificationFailure) operation.outcome('error', error.reason); throw error; }
        // Neither an expired token nor an unknown interaction can ever be edited: acknowledge (204).
        const lost = outcome === 'expired' || outcome === 'unknown_interaction';
        if (lost) operation.outcome('expired', outcome as 'expired' | 'unknown_interaction');
        else operation.outcome(outcome as 'skipped_web' | 'updated', 'none');
        write(`${JSON.stringify({ severity: lost ? 'WARNING' : 'INFO', function: 'discord-notifier',
          event_type: `discord.notification.${outcome}`, ...identifiers, ...operation.logFields() })}\n`);
      });
    } catch (error) {
      try {
        write(`${JSON.stringify({ severity: 'WARNING', function: 'discord-notifier', ...identifiers,
          event_type: error instanceof InvalidNotice ? 'discord.notification.invalid' : 'discord.notification.failed',
          ...(error instanceof InvalidNotice ? { reason: error.reason } : {}),
          ...(error instanceof NotificationFailure ? { reason: error.reason, http_status: error.status } : {}),
        })}\n`);
      } catch { /* Never serialize the original Error, URL or response. */ }
      if (error instanceof NotificationFailure && error.retryAfterSeconds) res.set('Retry-After', String(error.retryAfterSeconds));
      res.status(error instanceof InvalidNotice ? 400 : 503).json({ error: 'Discord notification unavailable.' }); return;
    }
    res.status(204).send();
  };
}

export const handleDiscordNotifier = createDiscordNotifierHandler({
  applicationId: process.env.DISCORD_APPLICATION_ID,
  subscriptions: {
    'pixel-processed': process.env.DISCORD_PROCESSED_SUBSCRIPTION ?? '',
    'pixel-rejected': process.env.DISCORD_REJECTED_SUBSCRIPTION ?? '',
    ...(process.env.DISCORD_COMMAND_REJECTED_SUBSCRIPTION
      ? { 'command-rejected': process.env.DISCORD_COMMAND_REJECTED_SUBSCRIPTION } : {}),
  },
  update: createOriginalResponseUpdater(),
});
