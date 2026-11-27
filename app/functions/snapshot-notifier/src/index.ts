import type { HttpFunction } from '@google-cloud/functions-framework';
import { Storage } from '@google-cloud/storage';
import {
  TOKEN_LIFETIME_MS, createOriginalResponseEditor, NotificationFailure, textResponse, type EditOriginalResponse,
} from '@pixelwar/shared/discord';
import { createFunctionTelemetry, type FunctionTelemetry } from '@pixelwar/shared/observability/function';
import { InvalidSnapshotRequest, parseSnapshotRequest, requestObjectName, snapshotEventId, type SnapshotRequest } from '@pixelwar/shared/snapshot';

export const MAX_PUSH_BYTES = 64 * 1024;
/** Limited lifetime of the posted link (subject §5.4); the image itself is kept 7 days. */
export const SIGNED_URL_LIFETIME_MS = 24 * 3_600_000;

export class InvalidNotification extends Error {
  constructor() { super('invalid_notification'); this.name = 'InvalidNotification'; }
}

export interface FinalizedObject { message_id: string; object: string; generation: string }
export type ReadRequest = (eventId: string) => Promise<unknown>;
export type SignUrl = (object: string, expires: number) => Promise<string>;

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * snapshot-ready is a native Cloud Storage notification (docs/events.md, section 5): only the
 * attributes are read. Another bucket, event type or format is a misconfiguration (400, then DLQ).
 */
export function parseFinalizePush(body: unknown, subscription: string, bucket: string): FinalizedObject {
  const message = record(body) ? body.message : undefined;
  const attributes = record(message) ? message.attributes : undefined;
  if (!record(body) || body.subscription !== subscription || !record(message) || typeof message.messageId !== 'string' ||
      !/^[1-9][0-9]{0,39}$/.test(message.messageId) || !record(attributes) || attributes.eventType !== 'OBJECT_FINALIZE' ||
      attributes.payloadFormat !== 'JSON_API_V1' || attributes.bucketId !== bucket ||
      typeof attributes.objectId !== 'string' || attributes.objectId.length < 1 || attributes.objectId.length > 1024 ||
      typeof attributes.objectGeneration !== 'string' || !/^[1-9][0-9]{0,19}$/.test(attributes.objectGeneration)) {
    throw new InvalidNotification();
  }
  return { message_id: message.messageId, object: attributes.objectId, generation: attributes.objectGeneration };
}

interface Options {
  applicationId?: string;
  subscription?: string;
  bucket?: string;
  readRequest?: ReadRequest;
  sign?: SignUrl;
  edit?: EditOriginalResponse;
  now?: () => number;
  write?: (line: string) => void;
  telemetry?: FunctionTelemetry;
}

/** Fixed sentence and a URL from our own signer: nothing provided by a user is interpolated. */
export function snapshotMessage(url: string, takenAt: number): string {
  const date = new Date(takenAt).toLocaleString('fr-FR', { timeZone: 'Europe/Paris', dateStyle: 'long', timeStyle: 'medium' });
  return `Snapshot du ${date} : ${url}\nLien valable 24 heures.`;
}

/**
 * BOT-07b: on OBJECT_FINALIZE of a snapshot, signs a V4 read URL and posts it in the deferred
 * answer of /snapshot. A notification delivered twice edits the same message again (@original):
 * never a second message.
 */
export function createSnapshotNotifierHandler(options: Options): HttpFunction {
  const write = options.write ?? ((line: string) => { process.stdout.write(line); });
  const telemetry = options.telemetry ?? createFunctionTelemetry('snapshot-notifier', { writeLog: write });
  const now = options.now ?? Date.now;
  const log = (severity: string, eventType: string, fields: Record<string, unknown> = {}) => {
    try { write(`${JSON.stringify({ severity, function: 'snapshot-notifier', event_type: eventType, ...fields })}\n`); }
    catch { /* Logging never fails a notification. */ }
  };
  return async (req, res): Promise<void> => {
    if (!options.applicationId || !options.subscription || !options.bucket || !options.readRequest || !options.sign || !options.edit) {
      res.status(503).json({ error: 'Snapshot notifier unavailable.' }); return;
    }
    if (req.path !== '/') { res.status(404).json({ error: 'Not found.' }); return; }
    if (req.method !== 'POST') { res.set('Allow', 'POST').status(405).json({ error: 'Method not allowed.' }); return; }
    if (!Buffer.isBuffer(req.rawBody) || req.rawBody.length > MAX_PUSH_BYTES) {
      res.status(413).json({ error: 'Invalid push body size.' }); return;
    }
    let finalized: FinalizedObject;
    try { finalized = parseFinalizePush(req.body, options.subscription, options.bucket); } catch (error) {
      if (!(error instanceof InvalidNotification)) throw error;
      log('WARNING', 'snapshot_notifier.message.invalid');
      res.status(400).json({ error: 'Invalid notification.' }); return;
    }
    const eventId = snapshotEventId(finalized.object);
    // The request objects and anything else of the bucket: nothing to post.
    if (!eventId) { log('INFO', 'snapshot_notifier.ignored', { message_id: finalized.message_id }); res.status(204).send(); return; }

    let request: SnapshotRequest;
    try {
      const raw = await options.readRequest(eventId);
      if (raw === null) {
        // Expired by the lifecycle rule (one day): the token died long before.
        log('WARNING', 'snapshot_notifier.request_missing', { event_id: eventId, message_id: finalized.message_id });
        res.status(204).send(); return;
      }
      request = parseSnapshotRequest(raw);
      if (request.event_id !== eventId || request.application_id !== options.applicationId) throw new InvalidSnapshotRequest();
    } catch (error) {
      const invalid = error instanceof InvalidSnapshotRequest;
      log(invalid ? 'WARNING' : 'ERROR', invalid ? 'snapshot_notifier.request_invalid' : 'snapshot_notifier.failed', { event_id: eventId });
      // A corrupt request will not improve with a retry; a read failure may.
      res.status(invalid ? 204 : 503).send(); return;
    }

    try {
      await telemetry.message('snapshot-ready', { correlation_id: request.correlation_id, traceparent: request.traceparent }, async (operation) => {
        operation.source('discord');
        operation.notificationAge(request.created_at);
        const target = { application_id: request.application_id, interaction_token: request.interaction_token, created_at: request.created_at };
        if (now() >= request.created_at + TOKEN_LIFETIME_MS) {
          operation.outcome('expired', 'expired');
          operation.log('WARNING', 'Snapshot link not posted: interaction expired.', 'snapshot_notifier.expired');
          return;
        }
        const url = await options.sign!(finalized.object, now() + SIGNED_URL_LIFETIME_MS);
        const edited = await options.edit!(target, textResponse(snapshotMessage(url, request.created_at)));
        if (edited !== 'updated') {
          operation.outcome('expired', edited);
          operation.log('WARNING', 'Snapshot link not shown.', edited === 'expired' ? 'snapshot_notifier.expired' : 'snapshot_notifier.unknown_interaction');
          return;
        }
        operation.outcome('updated');
        operation.log('INFO', 'Snapshot link posted.', 'snapshot_notifier.posted');
      });
    } catch (error) {
      // Never log the error: it may carry the token or the signed URL.
      log('ERROR', 'snapshot_notifier.failed', {
        event_id: eventId, correlation_id: request.correlation_id,
        ...(error instanceof NotificationFailure ? { reason: error.reason, http_status: error.status } : {}),
      });
      if (error instanceof NotificationFailure && error.retryAfterSeconds) res.set('Retry-After', String(error.retryAfterSeconds));
      res.status(503).json({ error: 'Snapshot notification unavailable.' }); return;
    }
    res.status(204).send();
  };
}

/** objectViewer on the snapshots bucket; signing goes through signBlob as the runtime identity itself. */
export function createBucketAccess(projectId: string, bucket: string): { readRequest: ReadRequest; sign: SignUrl } {
  let storage: Storage | undefined;
  const files = () => (storage ??= new Storage({ projectId })).bucket(bucket);
  return {
    async readRequest(eventId) {
      try {
        const [data] = await files().file(requestObjectName(eventId)).download();
        return JSON.parse(data.toString('utf8')) as unknown;
      } catch (error) {
        if ((error as { code?: number }).code === 404) return null;
        if (error instanceof SyntaxError) throw new InvalidSnapshotRequest();
        throw error;
      }
    },
    async sign(object, expires) {
      const [url] = await files().file(object).getSignedUrl({ version: 'v4', action: 'read', expires });
      return url;
    },
  };
}

const project = process.env.GOOGLE_CLOUD_PROJECT;
const bucket = process.env.SNAPSHOTS_BUCKET;
const access = project && bucket ? createBucketAccess(project, bucket) : undefined;
export const handleSnapshotNotifier = createSnapshotNotifierHandler({
  applicationId: process.env.DISCORD_APPLICATION_ID,
  subscription: process.env.SNAPSHOT_READY_SUBSCRIPTION,
  bucket,
  readRequest: access?.readRequest,
  sign: access?.sign,
  edit: createOriginalResponseEditor(),
});
