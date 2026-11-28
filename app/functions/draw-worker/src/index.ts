import type { HttpFunction } from '@google-cloud/functions-framework';
import { createFunctionTelemetry, type FunctionTelemetry } from '@pixelwar/shared/observability/function';
import { InvalidDrawMessage, MAX_PUSH_BYTES, isInvalidInput, parseDrawPush, snowflake } from './message';
import { createLazyDrawProcessor, type ProcessDraw } from './processor';
import { createResultPublisher, type PublishResult } from './publisher';
import { resultEvent } from './result';

interface Options {
  subscription?: string;
  applicationId?: string;
  process?: ProcessDraw;
  publish?: PublishResult;
  write?: (line: string) => void;
  telemetry?: FunctionTelemetry;
}

export function createDrawWorkerHandler(options: Options): HttpFunction {
  const write = options.write ?? ((line: string) => { process.stdout.write(line); });
  const telemetry = options.telemetry ?? createFunctionTelemetry('draw-worker', { writeLog: write });
  return async (req, res): Promise<void> => {
    if (!options.subscription || !/^projects\/[a-z][a-z0-9-]+\/subscriptions\/[a-zA-Z][a-zA-Z0-9._~+%-]{2,254}$/.test(options.subscription) ||
        options.applicationId !== undefined && !snowflake(options.applicationId) || !options.process || !options.publish) {
      res.status(503).json({ error: 'Draw worker unavailable.' }); return;
    }
    if (req.path !== '/') { res.status(404).json({ error: 'Not found.' }); return; }
    if (req.method !== 'POST') { res.set('Allow', 'POST').status(405).json({ error: 'Method not allowed.' }); return; }
    if (!Buffer.isBuffer(req.rawBody) || req.rawBody.length > MAX_PUSH_BYTES) {
      res.status(413).json({ error: 'Invalid push body size.' }); return;
    }
    try {
      const { command, discord, attributes, message_id } = parseDrawPush(req.body, options.subscription, options.applicationId);
      await telemetry.message('pixel-draw', attributes, async (operation) => {
        operation.source(command.source);
        operation.outcome('error', 'processing');
        // Where a push spends its time (DRAW-05): waiting for and running its group, then
        // publishing its result. The telemetry export comes after, in createFunctionTelemetry.
        const started = performance.now();
        const result = await options.process!(command);
        const process_ms = Math.round(performance.now() - started);
        operation.drawResult(result);
        const event = resultEvent(result, command, attributes.correlation_id, discord);
        operation.outcome('error', 'publish');
        const publishing = performance.now();
        await options.publish!(event, operation.attributes());
        const publish_ms = Math.round(performance.now() - publishing);
        operation.outcome(result.type === 'pixel-rejected' ? 'rejected' : 'published', result.reason ?? 'none');
        write(`${JSON.stringify({ severity: 'INFO', function: 'draw-worker', event_type: 'draw.result.published',
          event_id: event.event_id, correlation_id: event.correlation_id, message_id, result_type: event.type, process_ms, publish_ms,
          ...operation.logFields() })}\n`);
      });
    } catch (error) {
      try {
        write(`${JSON.stringify({ severity: 'WARNING', function: 'draw-worker',
          event_type: isInvalidInput(error) ? 'draw.message.invalid' : 'draw.processing.failed',
          ...(error instanceof InvalidDrawMessage ? { reason: error.reason } : {}) })}\n`);
      } catch { /* Never leak an SDK Error or acknowledge a failed operation. */ }
      res.status(isInvalidInput(error) ? 400 : 503).json({ error: 'Draw processing unavailable.' }); return;
    }
    res.status(204).send();
  };
}

const projectId = process.env.GOOGLE_CLOUD_PROJECT;
export const handleDrawWorker = createDrawWorkerHandler({
  subscription: process.env.PIXEL_DRAW_SUBSCRIPTION, applicationId: process.env.DISCORD_APPLICATION_ID,
  process: projectId ? createLazyDrawProcessor(projectId, (line) => { process.stdout.write(line); }) : undefined,
  publish: projectId ? createResultPublisher(projectId, {
    'pixel-processed': process.env.PIXEL_PROCESSED_TOPIC, 'pixel-rejected': process.env.PIXEL_REJECTED_TOPIC,
  }) : undefined,
});
