export interface EventOrder { occurred_at: string; event_id: string }

export function parseOccurredAt(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) throw new Error('occurred_at must be ISO UTC with milliseconds');
  const millis = Date.parse(value);
  if (!Number.isFinite(millis) || millis < -62_135_596_800_000 || new Date(millis).toISOString() !== value) {
    throw new Error('Invalid occurred_at');
  }
  return millis;
}

export function canonicalEventId(id: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new Error('event_id must be a UUID');
  const canonical = id.toLowerCase();
  if (canonical === '00000000-0000-0000-0000-000000000000') throw new Error('Nil event_id is not allowed');
  return canonical;
}

export function eventIdToBytes(id: string): Uint8Array {
  const hex = canonicalEventId(id).replaceAll('-', '');
  return Uint8Array.from({ length: 16 }, (_, i) => Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16));
}

export function eventIdFromBytes(bytes: Uint8Array): string {
  if (bytes.byteLength !== 16) throw new Error('Stored event_id must contain 16 bytes');
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return canonicalEventId(`${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`);
}

// Ascending time, then canonical lowercase UUID ASCII order. No locale collation.
export function compareEvents(a: EventOrder, b: EventOrder): -1 | 0 | 1 {
  const aTime = parseOccurredAt(a.occurred_at);
  const bTime = parseOccurredAt(b.occurred_at);
  const aId = canonicalEventId(a.event_id);
  const bId = canonicalEventId(b.event_id);
  if (aTime !== bTime) return aTime < bTime ? -1 : 1;
  return aId === bId ? 0 : aId < bId ? -1 : 1;
}
