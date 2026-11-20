import type { HttpFunction } from '@google-cloud/functions-framework';
import { GATEWAY_USERINFO_HEADER, gatewayIdentity } from '@pixelwar/shared/gateway';
import { createLogger } from '@pixelwar/shared/observability/logger';
import { createFunctionTelemetry, type FunctionTelemetry } from '@pixelwar/shared/observability/function';
import { InvalidDrawRequest, MAX_BODY_BYTES, parseDrawBody, webDrawEvent } from './request';
import { createDrawPublisher, type PublishDraw } from './publisher';

const ROUTE = '/api/pixels';

interface Options {
  /** https://frontend-<project number>.<region>.run.app, the only origin allowed by CORS. */
  frontendOrigin?: string;
  publish?: PublishDraw;
  now?: () => number;
  newId?: () => string;
  log?: ReturnType<typeof createLogger>;
  telemetry?: FunctionTelemetry;
}

/** DRAW-01: validates a browser draw and publishes it to pixel-draw; never writes Firestore. */
export function createWebProxyHandler(options: Options): HttpFunction {
  const now = options.now ?? Date.now;
  const log = options.log ?? createLogger({ serviceName: 'web-proxy', projectId: process.env.GOOGLE_CLOUD_PROJECT ?? '' });
  const telemetry = options.telemetry ?? createFunctionTelemetry('web-proxy', {
    writeLog: options.log ? (line) => {
      const record = JSON.parse(line);
      log(record.severity, record.message ?? 'Telemetry unavailable.', { event_type: record.event_type });
    } : undefined,
  });
  // The reason is a fixed code: never the body, the identity header or the pixels.
  const refuse = (reason: string) => log('WARNING', 'Web draw request refused.', { event_type: `web.proxy.refused.${reason}` });

  return async (req, res): Promise<void> => {
    res.set('Cache-Control', 'no-store');
    if (req.path !== ROUTE) { res.status(404).json({ error: 'not_found' }); return; }
    // CORS: the browser only reads answers addressed to the frontend origin.
    const origin = req.get('Origin');
    const allowed = origin !== undefined && origin === options.frontendOrigin;
    if (allowed) res.set({ 'Access-Control-Allow-Origin': origin, Vary: 'Origin' });
    if (req.method === 'OPTIONS') {
      if (!allowed) { res.status(403).json({ error: 'origin_not_allowed' }); return; }
      res.set({
        'Access-Control-Allow-Methods': 'POST',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        'Access-Control-Max-Age': '600',
      }).status(204).send();
      return;
    }
    if (req.method !== 'POST') { res.set('Allow', 'POST').status(405).json({ error: 'method_not_allowed' }); return; }
    if (!options.publish || !options.frontendOrigin) { res.status(503).json({ error: 'unavailable' }); return; }

    // The gateway already answered 401 without a valid session; a missing identity here
    // means a misconfigured route or a call that bypassed the gateway.
    const identity = gatewayIdentity(req.get(GATEWAY_USERINFO_HEADER));
    if (!identity) { refuse('invalid_identity'); res.status(401).json({ error: 'unauthenticated' }); return; }
    const body = req.rawBody;
    if (!Buffer.isBuffer(body) || body.length < 1 || body.length > MAX_BODY_BYTES) {
      refuse('invalid_body_size'); res.status(413).json({ error: 'invalid_body_size' }); return;
    }
    let event;
    try { event = webDrawEvent(parseDrawBody(body), identity, now(), options.newId); } catch (error) {
      const reason = error instanceof InvalidDrawRequest ? error.reason : 'invalid_body';
      refuse(reason); res.status(400).json({ error: reason }); return;
    }

    try {
      await telemetry.request(event.correlation_id, async (operation) => {
        operation.source('web');
        operation.outcome('error', 'publish');
        await options.publish!(event, operation.attributes());
        operation.outcome('published');
        operation.log('INFO', 'Web draw published.', 'web.proxy.published');
      }, 'web.pixels.draw');
    } catch {
      // Never log the SDK Error: it may carry the message. A timeout leaves the outcome uncertain.
      log('ERROR', 'Web draw publication failed; delivery may be uncertain.', { event_type: 'web.proxy.publish_failed' });
      res.status(503).json({ error: 'publish_unavailable' }); return;
    }
    res.status(202).json({ event_id: event.event_id, correlation_id: event.correlation_id });
  };
}

export const handleWebProxy = createWebProxyHandler({
  frontendOrigin: process.env.FRONTEND_ORIGIN,
  publish: process.env.GOOGLE_CLOUD_PROJECT && process.env.PIXEL_DRAW_TOPIC
    ? createDrawPublisher(process.env.GOOGLE_CLOUD_PROJECT, process.env.PIXEL_DRAW_TOPIC) : undefined,
});
