import { Firestore } from '@google-cloud/firestore';
import type { HttpFunction } from '@google-cloud/functions-framework';
import {
  TOKEN_LIFETIME_MS, createOriginalResponseEditor, NotificationFailure, type EditOriginalResponse,
} from '@pixelwar/shared/discord';
import { createFunctionTelemetry, type FunctionTelemetry } from '@pixelwar/shared/observability/function';
import { IMAGE_FILENAME, renderResponse } from './content';
import { InvalidRenderMessage, MAX_PUSH_BYTES, parseRenderPush, snowflake } from './message';
import { StoredDataError, createFirestoreRenderStore, renderCanvas, type RenderResult } from './render';

export type RenderCanvas = () => Promise<RenderResult>;

interface Options {
  applicationId?: string;
  subscription?: string;
  render?: RenderCanvas;
  edit?: EditOriginalResponse;
  now?: () => number;
  write?: (line: string) => void;
  telemetry?: FunctionTelemetry;
}

/** BOT-06: renders the painted area for /get and attaches the PNG to the deferred answer. */
export function createRenderWorkerHandler(options: Options): HttpFunction {
  const write = options.write ?? ((line: string) => { process.stdout.write(line); });
  const telemetry = options.telemetry ?? createFunctionTelemetry('render-worker', { writeLog: write });
  const now = options.now ?? Date.now;
  const subscription = options.subscription;
  return async (req, res): Promise<void> => {
    if (!snowflake(options.applicationId) || !subscription || !options.render || !options.edit) {
      res.status(503).json({ error: 'Render worker unavailable.' }); return;
    }
    if (req.path !== '/') { res.status(404).json({ error: 'Not found.' }); return; }
    if (req.method !== 'POST') { res.set('Allow', 'POST').status(405).json({ error: 'Method not allowed.' }); return; }
    if (!Buffer.isBuffer(req.rawBody) || req.rawBody.length > MAX_PUSH_BYTES) {
      res.status(413).json({ error: 'Invalid push body size.' }); return;
    }
    let identifiers: { event_id: string; correlation_id: string; message_id: string } | undefined;
    try {
      const request = parseRenderPush(req.body, subscription, options.applicationId);
      identifiers = { event_id: request.event_id, correlation_id: request.correlation_id, message_id: request.message_id };
      await telemetry.message('render-requested', request.attributes, async (operation) => {
        operation.notificationAge(request.target.created_at);
        // Nobody could see the image: do not spend the render budget on it.
        if (now() >= request.target.created_at + TOKEN_LIFETIME_MS) {
          operation.outcome('expired', 'expired');
          operation.log('WARNING', 'Render skipped: interaction expired.', 'render.notification_expired');
          return;
        }
        const result = await options.render!();
        const file = result.kind === 'image' ? { filename: IMAGE_FILENAME, data: result.image.png } : undefined;
        if (result.kind === 'image') operation.outcome('updated');
        else if (result.kind === 'empty') operation.outcome('updated', 'empty');
        else operation.outcome('rejected', 'too_large');
        // A redelivery edits the same message and replaces its attachment: never a second image.
        const edited = await options.edit!(request.target, renderResponse(result), file);
        if (edited !== 'updated') {
          operation.outcome('expired', edited);
          operation.log('WARNING', 'Render not shown.', edited === 'expired' ? 'render.notification_expired' : 'render.notification_unknown_interaction');
          return;
        }
        operation.log(result.kind === 'too_large' ? 'WARNING' : 'INFO',
          result.kind === 'image' ? 'Canvas image sent.' : result.kind === 'empty' ? 'Empty canvas answered.' : 'Painted area too large to render.',
          `render.${result.kind}`);
      });
    } catch (error) {
      const invalid = error instanceof InvalidRenderMessage;
      try {
        write(`${JSON.stringify({ severity: invalid ? 'WARNING' : 'ERROR', function: 'render-worker', ...identifiers,
          event_type: invalid ? 'render.message.invalid' : 'render.failed',
          ...(invalid ? { reason: error.reason } : {}),
          ...(error instanceof StoredDataError ? { reason: 'stored_data' } : {}),
          ...(error instanceof NotificationFailure ? { reason: error.reason, http_status: error.status } : {}),
        })}\n`);
      } catch { /* Never serialize the original Error: it may carry the interaction token. */ }
      if (error instanceof NotificationFailure && error.retryAfterSeconds) res.set('Retry-After', String(error.retryAfterSeconds));
      res.status(invalid ? 400 : 503).json({ error: 'Render unavailable.' }); return;
    }
    res.status(204).send();
  };
}

const project = process.env.GOOGLE_CLOUD_PROJECT;
const db = project ? new Firestore({ projectId: project }) : undefined;
const store = db ? createFirestoreRenderStore(db) : undefined;
export const handleRenderWorker = createRenderWorkerHandler({
  applicationId: process.env.DISCORD_APPLICATION_ID,
  subscription: process.env.RENDER_REQUESTED_SUBSCRIPTION,
  render: store ? () => renderCanvas(store) : undefined,
  edit: createOriginalResponseEditor(),
});
