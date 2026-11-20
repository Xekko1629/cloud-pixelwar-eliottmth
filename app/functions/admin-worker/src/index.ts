import { Firestore } from '@google-cloud/firestore';
import type { HttpFunction } from '@google-cloud/functions-framework';
import { createOriginalResponseEditor, NotificationFailure, type EditOriginalResponse } from '@pixelwar/shared/discord';
import type { AdminCommand } from '@pixelwar/shared/events';
import { createFunctionTelemetry, type FunctionTelemetry } from '@pixelwar/shared/observability/function';
import { AdminProcessingError, createAdminProcessor, type AdminOutcome } from './admin';
import { adminResponse } from './content';
import { InvalidAdminMessage, MAX_PUSH_BYTES, isAdmin, parseAdminPush, parsePermissions, snowflake, type Permissions } from './message';
import { purgeOldVersions, type PurgeReport } from './purge';

export type ApplyAdmin = (eventId: string, command: AdminCommand, actorUid: string) => Promise<AdminOutcome>;
export type PurgeTiles = (currentVersion: number) => Promise<PurgeReport>;

class PurgeIncomplete extends Error {
  constructor() { super('Old canvas versions are not fully purged yet.'); this.name = 'PurgeIncomplete'; }
}

interface Options {
  applicationId?: string;
  subscription?: string;
  permissions?: Permissions;
  apply?: ApplyAdmin;
  edit?: EditOriginalResponse;
  purge?: PurgeTiles;
  write?: (line: string) => void;
  telemetry?: FunctionTelemetry;
}

/** BOT-08 / DATA-04: applies /admin, answers the admin in Discord, then purges old tiles after a clear. */
export function createAdminWorkerHandler(options: Options): HttpFunction {
  const write = options.write ?? ((line: string) => { process.stdout.write(line); });
  const telemetry = options.telemetry ?? createFunctionTelemetry('admin-worker', { writeLog: write });
  const subscription = options.subscription;
  return async (req, res): Promise<void> => {
    if (!snowflake(options.applicationId) || !subscription || !options.permissions || !options.apply || !options.edit || !options.purge) {
      res.status(503).json({ error: 'Admin worker unavailable.' }); return;
    }
    if (req.path !== '/') { res.status(404).json({ error: 'Not found.' }); return; }
    if (req.method !== 'POST') { res.set('Allow', 'POST').status(405).json({ error: 'Method not allowed.' }); return; }
    if (!Buffer.isBuffer(req.rawBody) || req.rawBody.length > MAX_PUSH_BYTES) {
      res.status(413).json({ error: 'Invalid push body size.' }); return;
    }
    let identifiers: { event_id: string; correlation_id: string; message_id: string; subcommand: string } | undefined;
    try {
      const request = parseAdminPush(req.body, subscription, options.applicationId);
      identifiers = { event_id: request.event_id, correlation_id: request.correlation_id,
        message_id: request.message_id, subcommand: request.options.subcommand };
      await telemetry.message('admin-requested', request.attributes, async (operation) => {
        operation.notificationAge(request.target.created_at);
        // Second barrier after BOT-04: nothing is applied for an actor outside the allow-list.
        if (!isAdmin(request.actor, options.permissions!)) {
          operation.outcome('rejected', 'unauthorized');
          operation.log('WARNING', 'Admin command refused: not in the allow-list.', 'admin.unauthorized');
          const edited = await options.edit!(request.target, adminResponse({ status: 'unauthorized' }));
          if (edited === 'expired') operation.log('WARNING', 'Admin refusal not shown: interaction expired.', 'admin.notification_expired');
          return;
        }
        const { result, replayed } = await options.apply!(request.event_id, request.options, request.actor.uid);
        const clear = result.status === 'applied' && result.subcommand === 'clear' ? result : undefined;
        operation.outcome(result.status === 'applied' ? 'updated' : 'rejected');
        operation.log(result.status === 'applied' ? 'INFO' : 'WARNING',
          result.status === 'applied' ? 'Admin command applied.' : 'Admin command not applied: configuration missing.',
          `admin.${request.options.subcommand}.${replayed ? 'replayed' : result.status}`);
        const edited = await options.edit!(request.target, adminResponse(result, clear ? 'pending' : undefined));
        if (edited === 'expired') {
          operation.outcome('expired', 'expired');
          operation.log('WARNING', 'Admin answer not shown: interaction expired.', 'admin.notification_expired');
        }
        if (clear) {
          const report = await options.purge!(clear.canvas_version);
          operation.log(report.complete ? 'INFO' : 'WARNING', report.complete ? 'Old canvas versions purged.' : 'Purge budget reached.',
            report.complete ? 'admin.purge.complete' : 'admin.purge.incomplete');
          // Redelivery resumes the purge: the clear itself is deduplicated by admin_events.
          if (!report.complete) throw new PurgeIncomplete();
        }
      });
    } catch (error) {
      const invalid = error instanceof InvalidAdminMessage || (error instanceof AdminProcessingError && error.code === 'event_id_conflict');
      try {
        write(`${JSON.stringify({ severity: invalid ? 'WARNING' : 'ERROR', function: 'admin-worker', ...identifiers,
          event_type: invalid ? 'admin.message.invalid' : error instanceof PurgeIncomplete ? 'admin.purge.retry' : 'admin.failed',
          ...(error instanceof InvalidAdminMessage ? { reason: error.reason } : {}),
          ...(error instanceof AdminProcessingError ? { reason: error.code } : {}),
          ...(error instanceof NotificationFailure ? { reason: error.reason, http_status: error.status } : {}),
        })}\n`);
      } catch { /* Never serialize the original Error: it may carry the interaction token. */ }
      if (error instanceof NotificationFailure && error.retryAfterSeconds) res.set('Retry-After', String(error.retryAfterSeconds));
      res.status(invalid ? 400 : 503).json({ error: 'Admin command unavailable.' }); return;
    }
    res.status(204).send();
  };
}

const project = process.env.GOOGLE_CLOUD_PROJECT;
const db = project ? new Firestore({ projectId: project }) : undefined;
export const handleAdminWorker = createAdminWorkerHandler({
  applicationId: process.env.DISCORD_APPLICATION_ID,
  subscription: process.env.ADMIN_REQUESTED_SUBSCRIPTION,
  permissions: parsePermissions(process.env.DISCORD_ADMIN_ALLOWLIST),
  apply: db ? createAdminProcessor(db) : undefined,
  edit: createOriginalResponseEditor(),
  purge: db ? purgeOldVersions.bind(null, db) : undefined,
});
