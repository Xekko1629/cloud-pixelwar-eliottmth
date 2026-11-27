import type { HttpFunction } from '@google-cloud/functions-framework';
import { GATEWAY_USERINFO_HEADER, gatewayIdentity } from '@pixelwar/shared/gateway';
import { createLogger } from '@pixelwar/shared/observability/logger';
import { createFunctionTelemetry, type FunctionTelemetry } from '@pixelwar/shared/observability/function';
import { InvalidDrawRequest, MAX_BODY_BYTES, parseDrawBody, webDrawEvents } from './request';
import { createDrawPublisher, type PublishDraw } from './publisher';
import { createQuotaClient, type ReserveQuota } from './quota';

const ROUTE = '/api/pixels';

interface Options {
  /** https://frontend-<project number>.<region>.run.app, the only origin allowed by CORS. */
  frontendOrigin?: string;
  publish?: PublishDraw;
  /** quota-reserver (ADR-0017): the quota of the request, reserved before any publication. */
  reserve?: ReserveQuota;
  now?: () => number;
  newId?: () => string;
  log?: ReturnType<typeof createLogger>;
  telemetry?: FunctionTelemetry;
}

/**
 * DRAW-01: validates a browser draw, reserves its quota through quota-reserver (ADR-0017), then
 * publishes the granted pixels to pixel-draw. Never reads nor writes Firestore itself.
 */
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
    if (!options.publish || !options.reserve || !options.frontendOrigin) { res.status(503).json({ error: 'unavailable' }); return; }

    // The gateway already answered 401 without a valid session; a missing identity here
    // means a misconfigured route or a call that bypassed the gateway.
    const identity = gatewayIdentity(req.get(GATEWAY_USERINFO_HEADER));
    if (!identity) { refuse('invalid_identity'); res.status(401).json({ error: 'unauthenticated' }); return; }
    const body = req.rawBody;
    if (!Buffer.isBuffer(body) || body.length < 1 || body.length > MAX_BODY_BYTES) {
      refuse('invalid_body_size'); res.status(413).json({ error: 'invalid_body_size' }); return;
    }
    let stroke;
    try { stroke = webDrawEvents(parseDrawBody(body), identity, now(), options.newId); } catch (error) {
      const reason = error instanceof InvalidDrawRequest ? error.reason : 'invalid_body';
      refuse(reason); res.status(400).json({ error: reason }); return;
    }

    // One reservation per request: the first `granted` pixels of the stroke, never more.
    let reservation;
    try {
      reservation = await options.reserve({ reservation_id: stroke.correlation_id, uid: identity.uid, pixel_count: stroke.events.length });
    } catch {
      // Never the error: it may carry the request. Nothing is published, nothing is lost.
      log('ERROR', 'Quota reservation failed; nothing published.', { event_type: 'web.proxy.quota_unavailable' });
      res.status(503).json({ error: 'quota_unavailable' }); return;
    }
    if (reservation.granted === 0) {
      refuse(reservation.reason ?? 'insufficient_quota');
      if (reservation.retry_after_seconds !== null) res.set('Retry-After', String(reservation.retry_after_seconds));
      res.status(429).json({ error: reservation.reason, retry_after_seconds: reservation.retry_after_seconds }); return;
    }
    const events = stroke.events.slice(0, reservation.granted);

    try {
      await telemetry.request(stroke.correlation_id, async (operation) => {
        operation.source('web');
        operation.outcome('error', 'publish');
        const attributes = operation.attributes();
        // Wait for every publication, failed or not: no work may remain after the response.
        const results = await Promise.allSettled(events.map((event) => options.publish!(event, attributes)));
        if (results.some((result) => result.status === 'rejected')) throw new Error('Publication failed');
        operation.outcome('published');
        operation.log('INFO', 'Web stroke published.', 'web.proxy.published');
      }, 'web.pixels.draw');
    } catch {
      // Never log the SDK Error: it may carry the message. Some pixels may already be published,
      // and a timeout leaves the outcome uncertain: they stay valid (ADR-0014).
      log('ERROR', 'Web stroke publication failed; some pixels may be published.', { event_type: 'web.proxy.publish_failed' });
      res.status(503).json({ error: 'publish_unavailable' }); return;
    }
    res.status(202).json({
      correlation_id: stroke.correlation_id, event_ids: events.map((event) => event.event_id),
      ...(reservation.refused ? { refused: { count: reservation.refused, reason: reservation.reason, retry_after_seconds: reservation.retry_after_seconds } } : {}),
    });
  };
}

export const handleWebProxy = createWebProxyHandler({
  frontendOrigin: process.env.FRONTEND_ORIGIN,
  publish: process.env.GOOGLE_CLOUD_PROJECT && process.env.PIXEL_DRAW_TOPIC
    ? createDrawPublisher(process.env.GOOGLE_CLOUD_PROJECT, process.env.PIXEL_DRAW_TOPIC) : undefined,
  reserve: process.env.QUOTA_RESERVER_URL?.startsWith('https://') ? createQuotaClient(process.env.QUOTA_RESERVER_URL) : undefined,
});
