import { Timestamp, type Firestore } from '@google-cloud/firestore';
import {
  COLLECTIONS, DEFAULT_MAX_BATCH_PIXELS, RATE_LIMIT_WINDOW_MS, evaluateRateLimit, resolveRateLimit,
  type GlobalConfigDocument, type RateLimitOverrideDocument, type UserStateDocument,
} from '../grid';
import { runDrawTransaction } from './retry';
import { validateConfig } from './transaction';

/** One web request (1 to 500 pixels) asks for its quota once, before publication (ADR-0017). */
export interface ReservationRequest {
  /** correlation_id of the web request: the same id never reserves twice. */
  reservation_id: string;
  uid: string;
  pixel_count: number;
}

export interface Reservation {
  /** The FIRST `granted` pixels of the request may be published; the others never are. */
  granted: number;
  refused: number;
  reason?: 'insufficient_quota' | 'drawing_disabled' | 'paused';
  /** null: waiting alone cannot make the refused pixels fit. */
  retry_after_seconds: number | null;
  limit_per_minute: number;
  remaining_pixels: number;
  reset_at: string;
}

export class InvalidReservationRequest extends Error {
  constructor() { super('Invalid reservation request'); this.name = 'InvalidReservationRequest'; }
}

const RESERVATION_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const UID = /^[0-9]{17,20}$/;

export function parseReservationRequest(value: unknown): ReservationRequest {
  const body = value as Record<string, unknown> | null;
  if (typeof body !== 'object' || body === null || Array.isArray(body) ||
      Object.keys(body).sort().join(',') !== 'pixel_count,reservation_id,uid' ||
      typeof body.reservation_id !== 'string' || !RESERVATION_ID.test(body.reservation_id) ||
      typeof body.uid !== 'string' || !UID.test(body.uid) ||
      typeof body.pixel_count !== 'number' || !Number.isSafeInteger(body.pixel_count) ||
      body.pixel_count < 1 || body.pixel_count > DEFAULT_MAX_BATCH_PIXELS) {
    throw new InvalidReservationRequest();
  }
  return { reservation_id: body.reservation_id, uid: body.uid, pixel_count: body.pixel_count };
}

interface StoredReservation { id: string; at: Timestamp; result: Reservation }
type UserDocument = UserStateDocument & { last_reservation?: StoredReservation };

export interface ReservationOptions { root?: string; now?: () => number }

/**
 * Reserves the quota of a web request in ONE transaction on users/{uid}, with the pure rule of
 * rate-limit.ts: the first min(requested, remaining) pixels are granted. A paused canvas or a
 * zero limit grants nothing and consumes nothing. users/{uid}.last_reservation remembers the
 * last answer, so a retry of the same reservation_id returns it without counting again.
 */
export function createQuotaReservation(db: Firestore, options: ReservationOptions = {}) {
  const now = options.now ?? Date.now;
  const ref = (path: string) => db.doc(options.root ? `${options.root}/${path}` : path);

  return async (input: ReservationRequest): Promise<Reservation> => {
    const request = parseReservationRequest(input);
    const configRef = ref(`${COLLECTIONS.config}/global`);
    const userRef = ref(`${COLLECTIONS.users}/${request.uid}`);
    return runDrawTransaction(db, async (tx) => {
      const [global, override, user] = await tx.getAll(configRef, ref(`${COLLECTIONS.overrides}/${request.uid}`), userRef);
      const config = global.data() as GlobalConfigDocument;
      validateConfig(config);
      const stored = user.exists ? user.data() as UserDocument : null;
      if (stored?.last_reservation?.id === request.reservation_id) return stored.last_reservation.result;

      const overrideData = override.exists ? override.data() as RateLimitOverrideDocument : null;
      const nowMs = now();
      const ask = (pixel_count: number) => evaluateRateLimit({ config, override: overrideData, usage: stored, now_ms: nowMs, pixel_count });
      const full = ask(request.pixel_count);
      const summary = { limit_per_minute: full.limit_per_minute, reset_at: new Date(full.reset_at_ms).toISOString() };
      const waitSeconds = Math.ceil((full.reset_at_ms - nowMs) / 1000);

      let result: Reservation;
      let decision = full;
      if (config.paused) {
        result = { granted: 0, refused: request.pixel_count, reason: 'paused', retry_after_seconds: null, remaining_pixels: full.remaining_pixels, ...summary };
      } else if (full.allowed) {
        result = { granted: request.pixel_count, refused: 0, retry_after_seconds: null, remaining_pixels: full.remaining_pixels, ...summary };
      } else if (full.reason === 'drawing_disabled') {
        result = { granted: 0, refused: request.pixel_count, reason: 'drawing_disabled', retry_after_seconds: null, remaining_pixels: 0, ...summary };
      } else if (full.remaining_pixels > 0) {
        decision = ask(full.remaining_pixels); // Fits by construction: the start of the stroke is granted.
        result = {
          granted: full.remaining_pixels, refused: request.pixel_count - full.remaining_pixels, reason: 'insufficient_quota',
          retry_after_seconds: waitSeconds, remaining_pixels: decision.remaining_pixels, ...summary,
        };
      } else {
        result = { granted: 0, refused: request.pixel_count, reason: 'insufficient_quota', retry_after_seconds: waitSeconds, remaining_pixels: 0, ...summary };
      }

      const at = Timestamp.fromMillis(nowMs);
      const lastReservation: StoredReservation = { id: request.reservation_id, at, result };
      const lastRejection = result.reason
        ? { event_id: request.reservation_id, reason: result.reason === 'paused' ? 'paused' : 'rate_limit', at } : null;
      if (decision.allowed && result.granted > 0) {
        const next = decision.next_usage;
        tx.set(userRef, {
          window_start: Timestamp.fromMillis(next.window_start_ms), used_pixels: next.used_pixels,
          limit_per_minute: next.limit_per_minute, updated_at: at, last_rejection: lastRejection, last_reservation: lastReservation,
        }, { merge: true });
      } else if (user.exists) {
        tx.update(userRef, { last_rejection: lastRejection, updated_at: at, last_reservation: lastReservation });
      } else {
        // First action refused: created with nothing consumed, so GET /api/state can explain it.
        tx.set(userRef, {
          window_start: Timestamp.fromMillis(Math.floor(nowMs / RATE_LIMIT_WINDOW_MS) * RATE_LIMIT_WINDOW_MS),
          used_pixels: 0, limit_per_minute: resolveRateLimit(config, overrideData), updated_at: at,
          last_rejection: lastRejection, last_reservation: lastReservation,
        });
      }
      return result;
    });
  };
}
