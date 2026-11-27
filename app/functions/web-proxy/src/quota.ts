import { GoogleAuth, type IdTokenClient } from 'google-auth-library';
import type { Reservation, ReservationRequest } from '@pixelwar/shared/drawing';

export type ReserveQuota = (request: ReservationRequest) => Promise<Reservation>;

const count = (value: unknown, max: number): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max;
const REASONS = new Set(['insufficient_quota', 'drawing_disabled', 'paused']);

/** An answer that does not add up is refused: the proxy never publishes more than it was granted. */
export function parseReservation(value: unknown, requested: number): Reservation {
  const body = value as Record<string, unknown> | null;
  if (typeof body !== 'object' || body === null || !count(body.granted, requested) || body.refused !== requested - body.granted ||
      (body.refused > 0) !== (typeof body.reason === 'string' && REASONS.has(body.reason)) ||
      !(body.retry_after_seconds === null || count(body.retry_after_seconds, 60)) ||
      !count(body.limit_per_minute, Number.MAX_SAFE_INTEGER) || !count(body.remaining_pixels, Number.MAX_SAFE_INTEGER) ||
      typeof body.reset_at !== 'string' || Number.isNaN(Date.parse(body.reset_at))) {
    throw new Error('Invalid quota-reserver answer');
  }
  return body as unknown as Reservation;
}

/**
 * Calls quota-reserver with an ID token of the web-proxy service account (ADR-0017). One retry
 * on a network or server error: the same reservation_id never counts twice.
 */
export function createQuotaClient(url: string, auth: Pick<GoogleAuth, 'getIdTokenClient'> = new GoogleAuth()): ReserveQuota {
  let client: Promise<IdTokenClient> | undefined;
  return async (request) => {
    client ??= auth.getIdTokenClient(url);
    let last: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await (await client).request({ url, method: 'POST', data: request, timeout: 5000, retry: false });
        return parseReservation(response.data, request.pixel_count);
      } catch (error) {
        last = error;
        const status = (error as { response?: { status?: number } }).response?.status;
        if (status !== undefined && status < 500) break; // 4xx: retrying gives the same answer.
      }
    }
    throw last;
  };
}
