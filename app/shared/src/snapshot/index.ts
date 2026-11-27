import { canonicalEventId } from '../grid';

// /snapshot (BOT-07a/b, option A of 26/11): contract between the snapshot-worker and the
// snapshot-notifier, through the private snapshots bucket only.
//
// The interaction token goes in a request object, never in the image metadata: Cloud Storage
// returns custom metadata as x-goog-meta-* headers on every download, including through the
// signed URL posted in the channel. The image metadata only carries the event id.

export const SNAPSHOT_PREFIX = 'snapshots/';
export const REQUEST_PREFIX = 'requests/';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const OBJECT = new RegExp(`^snapshots/(\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-\\d{3}Z)_(${UUID})\\.png$`);

/** Timestamped (ISO-8601, ':' and '.' replaced) and stable for one request: a redelivery targets the same object. */
export function snapshotObjectName(occurredAt: string, eventId: string): string {
  const time = new Date(occurredAt);
  if (Number.isNaN(time.getTime()) || time.toISOString() !== occurredAt) throw new Error('occurred_at must be a canonical ISO-8601 instant');
  return `${SNAPSHOT_PREFIX}${occurredAt.replace(/[:.]/g, '-')}_${canonicalEventId(eventId)}.png`;
}

/** Event id of a snapshot image, or null for any other object of the bucket. */
export function snapshotEventId(objectName: string): string | null {
  return OBJECT.exec(objectName)?.[2] ?? null;
}

export function requestObjectName(eventId: string): string {
  return `${REQUEST_PREFIX}${canonicalEventId(eventId)}.json`;
}

/** Secret: holds the interaction token. Deleted by a lifecycle rule after one day (the token lives 15 min). */
export interface SnapshotRequest {
  schema_version: 1;
  event_id: string;
  correlation_id: string;
  /** The storage notification carries no trace context: the notifier continues this one (BOT-09). */
  traceparent: string;
  application_id: string;
  interaction_token: string;
  /** Interaction creation time (ms), for the 15-minute token expiry. */
  created_at: number;
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const snowflake = (value: unknown): value is string => typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value);

export class InvalidSnapshotRequest extends Error {
  constructor() { super('Invalid snapshot request'); this.name = 'InvalidSnapshotRequest'; }
}

export function parseSnapshotRequest(value: unknown): SnapshotRequest {
  const keys = 'application_id,correlation_id,created_at,event_id,interaction_token,schema_version,traceparent';
  try {
    if (!record(value) || Object.keys(value).sort().join(',') !== keys || value.schema_version !== 1 ||
        typeof value.event_id !== 'string' || canonicalEventId(value.event_id) !== value.event_id ||
        value.correlation_id !== value.event_id || !snowflake(value.application_id) ||
        typeof value.traceparent !== 'string' || !/^00-(?!0{32}-)[a-f0-9]{32}-(?!0{16}-)[a-f0-9]{16}-0[01]$/.test(value.traceparent) ||
        typeof value.interaction_token !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(value.interaction_token) ||
        typeof value.created_at !== 'number' || !Number.isSafeInteger(value.created_at) || value.created_at < 0) {
      throw new Error();
    }
  } catch { throw new InvalidSnapshotRequest(); }
  return value as unknown as SnapshotRequest;
}
