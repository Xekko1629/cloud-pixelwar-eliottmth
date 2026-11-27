import { Firestore } from '@google-cloud/firestore';
import type { HttpFunction } from '@google-cloud/functions-framework';
import { Storage } from '@google-cloud/storage';
import {
  TOKEN_LIFETIME_MS, createOriginalResponseEditor, NotificationFailure, textResponse, type EditOriginalResponse,
} from '@pixelwar/shared/discord';
import { InvalidRenderMessage, MAX_PUSH_BYTES, parseRenderPush, snowflake } from '@pixelwar/shared/discord/request-push';
import { createFunctionTelemetry, type FunctionTelemetry } from '@pixelwar/shared/observability/function';
import { SNAPSHOT_RENDER_OPTIONS } from '@pixelwar/shared/render';
import { StoredDataError, createFirestoreRenderStore, renderCanvas, type RenderResult } from '@pixelwar/shared/render/canvas';
import { requestObjectName, snapshotObjectName, type SnapshotRequest } from '@pixelwar/shared/snapshot';

export type RenderSnapshot = () => Promise<RenderResult>;
/** Creates an object only if it does not exist yet; false when it already did (redelivery). */
export type CreateObject = (name: string, data: Uint8Array, contentType: string, metadata?: Record<string, string>) => Promise<boolean>;

interface Options {
  applicationId?: string;
  subscription?: string;
  render?: RenderSnapshot;
  create?: CreateObject;
  edit?: EditOriginalResponse;
  now?: () => number;
  write?: (line: string) => void;
  telemetry?: FunctionTelemetry;
}

/** Fixed sentences only: nothing provided by a user is interpolated. */
export const EMPTY_MESSAGE = 'La toile est vide pour l’instant : il n’y a rien à photographier. Dessine le premier pixel avec /draw.';
export const TOO_LARGE_MESSAGE = 'La zone peinte est trop grande pour un snapshot. Demande à un administrateur de borner la grille avec /admin size.';

/**
 * BOT-07a: renders the painted area (DATA-05b, up to 4096 px) and stores it in the private
 * snapshots bucket. The snapshot-notifier posts the signed URL once Cloud Storage reports
 * the new object (subject §5.4). Only an empty or too large canvas is answered from here.
 */
export function createSnapshotWorkerHandler(options: Options): HttpFunction {
  const write = options.write ?? ((line: string) => { process.stdout.write(line); });
  const telemetry = options.telemetry ?? createFunctionTelemetry('snapshot-worker', { writeLog: write });
  const now = options.now ?? Date.now;
  return async (req, res): Promise<void> => {
    if (!snowflake(options.applicationId) || !options.subscription || !options.render || !options.create || !options.edit) {
      res.status(503).json({ error: 'Snapshot worker unavailable.' }); return;
    }
    if (req.path !== '/') { res.status(404).json({ error: 'Not found.' }); return; }
    if (req.method !== 'POST') { res.set('Allow', 'POST').status(405).json({ error: 'Method not allowed.' }); return; }
    if (!Buffer.isBuffer(req.rawBody) || req.rawBody.length > MAX_PUSH_BYTES) {
      res.status(413).json({ error: 'Invalid push body size.' }); return;
    }
    let identifiers: { event_id: string; correlation_id: string; message_id: string } | undefined;
    try {
      const request = parseRenderPush(req.body, options.subscription, options.applicationId, 'snapshot-requested');
      identifiers = { event_id: request.event_id, correlation_id: request.correlation_id, message_id: request.message_id };
      await telemetry.message('snapshot-requested', request.attributes, async (operation) => {
        operation.notificationAge(request.target.created_at);
        // Nobody could receive the link: do not spend the render budget on it.
        if (now() >= request.target.created_at + TOKEN_LIFETIME_MS) {
          operation.outcome('expired', 'expired');
          operation.log('WARNING', 'Snapshot skipped: interaction expired.', 'snapshot.notification_expired');
          return;
        }
        const result = await options.render!();
        if (result.kind !== 'image') {
          operation.outcome(result.kind === 'empty' ? 'updated' : 'rejected', result.kind);
          const edited = await options.edit!(request.target, textResponse(result.kind === 'empty' ? EMPTY_MESSAGE : TOO_LARGE_MESSAGE));
          operation.log(result.kind === 'empty' ? 'INFO' : 'WARNING',
            edited === 'updated' ? 'Snapshot not taken.' : 'Snapshot answer not shown.', `snapshot.${result.kind}`);
          return;
        }
        // The request first: when Cloud Storage reports the image, its request already exists.
        const stored: SnapshotRequest = {
          schema_version: 1, event_id: request.event_id, correlation_id: request.correlation_id,
          traceparent: operation.attributes().traceparent, application_id: request.target.application_id,
          interaction_token: request.target.interaction_token, created_at: request.target.created_at,
        };
        await options.create!(requestObjectName(request.event_id), Buffer.from(JSON.stringify(stored)), 'application/json');
        const occurredAt = new Date(request.target.created_at).toISOString();
        const created = await options.create!(snapshotObjectName(occurredAt, request.event_id), result.image.png, 'image/png',
          { event_id: request.event_id, canvas_version: String(result.canvas_version) });
        operation.outcome('published');
        operation.log('INFO', created ? 'Snapshot stored.' : 'Snapshot already stored.', created ? 'snapshot.stored' : 'snapshot.already_stored');
      });
    } catch (error) {
      const invalid = error instanceof InvalidRenderMessage;
      try {
        write(`${JSON.stringify({ severity: invalid ? 'WARNING' : 'ERROR', function: 'snapshot-worker', ...identifiers,
          event_type: invalid ? 'snapshot.message.invalid' : 'snapshot.failed',
          ...(invalid ? { reason: error.reason } : {}),
          ...(error instanceof StoredDataError ? { reason: 'stored_data' } : {}),
          ...(error instanceof NotificationFailure ? { reason: error.reason, http_status: error.status } : {}),
        })}\n`);
      } catch { /* Never serialize the original Error: it may carry the interaction token. */ }
      res.status(invalid ? 400 : 503).json({ error: 'Snapshot unavailable.' }); return;
    }
    res.status(204).send();
  };
}

/** objectCreator only: never overwrites. A 412 means the object of this request already exists. */
export function createBucketWriter(storage: Storage, bucket: string): CreateObject {
  return async (name, data, contentType, metadata) => {
    try {
      await storage.bucket(bucket).file(name).save(Buffer.from(data), {
        resumable: false, contentType, preconditionOpts: { ifGenerationMatch: 0 },
        ...(metadata ? { metadata: { metadata } } : {}),
      });
      return true;
    } catch (error) {
      if ((error as { code?: number }).code === 412) return false;
      throw error;
    }
  };
}

const project = process.env.GOOGLE_CLOUD_PROJECT;
const bucket = process.env.SNAPSHOTS_BUCKET;
const store = project ? createFirestoreRenderStore(new Firestore({ projectId: project })) : undefined;
export const handleSnapshotWorker = createSnapshotWorkerHandler({
  applicationId: process.env.DISCORD_APPLICATION_ID,
  subscription: process.env.SNAPSHOT_REQUESTED_SUBSCRIPTION,
  render: store ? () => renderCanvas(store, SNAPSHOT_RENDER_OPTIONS) : undefined,
  create: project && bucket ? createBucketWriter(new Storage({ projectId: project }), bucket) : undefined,
  edit: createOriginalResponseEditor(),
});
