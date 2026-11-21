import { Timestamp, type Firestore } from '@google-cloud/firestore';
import { RESULT_RETENTION_MS } from '@pixelwar/shared/drawing';
import { COLLECTIONS, assertCanvasVersion, validateGridSize, type GridSize } from '@pixelwar/shared/grid';
import type { AdminCommand } from '@pixelwar/shared/events';

export const ADMIN_EVENTS = 'admin_events';

export type AdminResult =
  | { status: 'applied'; subcommand: 'pause' | 'resume' }
  | { status: 'applied'; subcommand: 'clear'; canvas_version: number }
  | { status: 'applied'; subcommand: 'ratelimit'; user: string; limit: number }
  | { status: 'applied'; subcommand: 'size'; size: GridSize | null }
  | { status: 'rejected'; subcommand: AdminCommand['subcommand']; reason: 'configuration_missing' };

export interface AdminOutcome { result: AdminResult; replayed: boolean }

export class AdminProcessingError extends Error {
  constructor(readonly code: 'event_id_conflict' | 'invalid_stored_result') {
    super(code); this.name = 'AdminProcessingError';
  }
}

interface Options { root?: string; now?: () => number }

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Applies one /admin command in a single transaction with its deduplication record
 * (admin_events/<event_id>): a redelivered clear never increments canvas_version twice.
 * No Discord or Pub/Sub call inside: Firestore may rerun the callback.
 */
export function createAdminProcessor(db: Firestore, options: Options = {}) {
  const ref = (path: string) => db.doc(options.root ? `${options.root}/${path}` : path);
  const now = options.now ?? Date.now;

  return async (eventId: string, command: AdminCommand, actorUid: string): Promise<AdminOutcome> => {
    if (command.subcommand === 'size' && command.width !== undefined) {
      validateGridSize({ width: command.width, height: command.height! });
    }
    const eventRef = ref(`${ADMIN_EVENTS}/${eventId}`);
    const configRef = ref(`${COLLECTIONS.config}/global`);
    return db.runTransaction(async (tx) => {
      const existing = await tx.get(eventRef);
      if (existing.exists) return { result: storedResult(existing.data(), command), replayed: true };

      const config = (await tx.get(configRef)).data();
      const at = now();
      let result: AdminResult;
      // DATA-02 refuses to draw without a valid configuration: never create a partial one here.
      if (!record(config) || !validVersion(config.canvas_version)) {
        result = { status: 'rejected', subcommand: command.subcommand, reason: 'configuration_missing' };
      } else if (command.subcommand === 'pause' || command.subcommand === 'resume') {
        tx.update(configRef, { paused: command.subcommand === 'pause' });
        result = { status: 'applied', subcommand: command.subcommand };
      } else if (command.subcommand === 'clear') {
        // Constant cost (ADR-0007): old tiles stop being read; the purge removes them afterwards.
        const version = (config.canvas_version as number) + 1;
        assertCanvasVersion(version);
        tx.update(configRef, { canvas_version: version, bounds: null });
        result = { status: 'applied', subcommand: 'clear', canvas_version: version };
      } else if (command.subcommand === 'size') {
        const size = command.width === undefined ? null : { width: command.width, height: command.height! };
        tx.update(configRef, { size });
        result = { status: 'applied', subcommand: 'size', size };
      } else if (command.subcommand === 'ratelimit') {
        // Override only: the usage counter and its window are never touched (rate-limits.md).
        tx.set(ref(`${COLLECTIONS.overrides}/${command.user}`), {
          limit_per_minute: command.limit, updated_at: Timestamp.fromMillis(at),
        });
        result = { status: 'applied', subcommand: 'ratelimit', user: command.user, limit: command.limit };
      } else {
        // Unreachable: parseOptions only produces the five subcommands above.
        /* v8 ignore next */
        throw new Error('Unknown admin subcommand');
      }
      tx.create(eventRef, {
        schema_version: 1, event_id: eventId, subcommand: command.subcommand, actor_uid: actorUid, result,
        created_at: Timestamp.fromMillis(at), expire_at: Timestamp.fromMillis(at + RESULT_RETENTION_MS),
      });
      return { result, replayed: false };
    });
  };
}

function validVersion(value: unknown): value is number {
  try { assertCanvasVersion(value as number); return true; } catch { return false; }
}

function storedResult(data: unknown, command: AdminCommand): AdminResult {
  if (!record(data) || data.schema_version !== 1 || !record(data.result)) throw new AdminProcessingError('invalid_stored_result');
  // Same event_id with another subcommand: not a redelivery, never apply or answer it.
  if (data.subcommand !== command.subcommand || data.result.subcommand !== command.subcommand) {
    throw new AdminProcessingError('event_id_conflict');
  }
  return data.result as AdminResult;
}
