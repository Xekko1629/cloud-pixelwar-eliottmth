import { Firestore } from '@google-cloud/firestore';
import type { HttpFunction } from '@google-cloud/functions-framework';
import {
  InvalidReservationRequest, createQuotaReservation, parseReservationRequest, type Reservation, type ReservationRequest,
} from '@pixelwar/shared/drawing';

export type Reserve = (request: ReservationRequest) => Promise<Reservation>;
/** { reservation_id, uid, pixel_count } is about 100 bytes. */
export const MAX_BODY_BYTES = 1024;

interface Options { reserve?: Reserve; write?: (line: string) => void }

/**
 * ADR-0017: reserves the quota of one web request before web-proxy publishes its pixels.
 * Called only by web-proxy: Cloud Run checks the caller's ID token (roles/run.invoker) before
 * this code runs, and the gateway has no route here. Logs never carry the uid.
 */
export function createQuotaReserverHandler(options: Options): HttpFunction {
  const write = options.write ?? ((line: string) => { process.stdout.write(line); });
  const log = (severity: string, eventType: string, fields: Record<string, unknown> = {}) => {
    try { write(`${JSON.stringify({ severity, function: 'quota-reserver', event_type: eventType, ...fields })}\n`); } catch { /* Best effort. */ }
  };
  return async (req, res): Promise<void> => {
    res.set('Cache-Control', 'no-store');
    if (!options.reserve) { res.status(503).json({ error: 'unavailable' }); return; }
    if (req.path !== '/') { res.status(404).json({ error: 'not_found' }); return; }
    if (req.method !== 'POST') { res.set('Allow', 'POST').status(405).json({ error: 'method_not_allowed' }); return; }
    if (!Buffer.isBuffer(req.rawBody) || req.rawBody.length < 1 || req.rawBody.length > MAX_BODY_BYTES) {
      log('WARNING', 'quota.request.invalid'); res.status(413).json({ error: 'invalid_body_size' }); return;
    }
    let request: ReservationRequest;
    try { request = parseReservationRequest(JSON.parse(req.rawBody.toString('utf8'))); } catch {
      log('WARNING', 'quota.request.invalid'); res.status(400).json({ error: 'invalid_request' }); return;
    }
    try {
      const reservation = await options.reserve(request);
      log('INFO', reservation.granted ? 'quota.reserved' : 'quota.refused', {
        correlation_id: request.reservation_id, requested: request.pixel_count, granted: reservation.granted,
        ...(reservation.reason ? { reason: reservation.reason } : {}),
      });
      res.status(200).json(reservation);
    } catch (error) {
      // Never the SDK error: it may carry document paths, hence the uid.
      log('ERROR', 'quota.failed', { correlation_id: request.reservation_id, invalid: error instanceof InvalidReservationRequest });
      res.status(503).json({ error: 'unavailable' });
    }
  };
}

let reserve: Reserve | undefined;
const projectId = process.env.GOOGLE_CLOUD_PROJECT;
export const handleQuotaReserver = createQuotaReserverHandler({
  // No Firestore client before the first request: a refused call never opens one.
  reserve: projectId ? (request) => (reserve ??= createQuotaReservation(new Firestore({ projectId })))(request) : undefined,
});
