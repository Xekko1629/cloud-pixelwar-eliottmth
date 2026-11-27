import { describe, expect, it } from 'vitest';
import { parseSnapshotRequest, requestObjectName, snapshotEventId, snapshotObjectName } from '.';

const eventId = '0f8c1f5e-2d3a-8b4c-9d5e-6f7a8b9c0d1e';
const request = {
  schema_version: 1, event_id: eventId, correlation_id: eventId, traceparent: `00-${'1'.repeat(32)}-${'2'.repeat(16)}-01`,
  application_id: '123456789012345678', interaction_token: 'synthetic-interaction-token', created_at: 1_764_158_400_000,
};

describe('snapshot contract (BOT-07a/b)', () => {
  it('names a timestamped image stable for one request, and reads its event id back', () => {
    const name = snapshotObjectName('2026-11-26T12:00:00.000Z', eventId);
    expect(name).toBe(`snapshots/2026-11-26T12-00-00-000Z_${eventId}.png`);
    expect(snapshotEventId(name)).toBe(eventId);
    expect(requestObjectName(eventId)).toBe(`requests/${eventId}.json`);
  });
  it('ignores any other object of the bucket', () => {
    for (const name of [requestObjectName(eventId), `snapshots/x_${eventId}.png`, `snapshots/2026-11-26T12-00-00-000Z_${eventId}.jpg`, 'other.png']) {
      expect(snapshotEventId(name)).toBeNull();
    }
  });
  it('refuses a non-canonical date or event id', () => {
    expect(() => snapshotObjectName('2026-11-26T12:00:00Z', eventId)).toThrow('canonical');
    expect(() => snapshotObjectName('2026-11-26T12:00:00.000Z', 'not-an-id')).toThrow();
  });
  it('accepts a complete request and refuses anything else', () => {
    expect(parseSnapshotRequest(request)).toEqual(request);
    for (const bad of [null, { ...request, extra: 1 }, { ...request, schema_version: 2 }, { ...request, correlation_id: 'x' },
      { ...request, event_id: 'x', correlation_id: 'x' }, { ...request, application_id: '01' }, { ...request, traceparent: '00-0-0-01' },
      { ...request, interaction_token: '' }, { ...request, interaction_token: 'a b' }, { ...request, created_at: -1 }, { ...request, created_at: 1.5 }]) {
      expect(() => parseSnapshotRequest(bad)).toThrow('Invalid snapshot request');
    }
  });
});
