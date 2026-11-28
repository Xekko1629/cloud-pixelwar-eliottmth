import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Timestamp } from '@google-cloud/firestore';
import { tileId } from '../grid';
import { prepareDraw } from './command';
import { estimateTileBytes, planTileChanges, type TileChange } from './tiles';

const now = Date.parse('2026-11-19T10:00:30.000Z');
const command = (event_id = randomUUID(), time = now) => prepareDraw({
  event_id, occurred_at: new Date(time).toISOString(), source: 'web',
  author: { uid: '123456789012345678', name: 'Test user' }, pixels: [{ x: 0, y: 0, color: 2 }],
}, 500);
const tile = (): TileChange => ({ id: tileId(1, 0, 0), tx: 0, ty: 0, pixels: [{ x: 0, y: 0, color: 2 }] });
const painted = () => {
  const result = planTileChanges(tile(), command(), 1, now);
  return { ...tile(), colors: result.colors, metadata: result.metadata };
};

describe('tile planning', () => {
  it('creates paired documents and preserves the input', () => {
    const input = tile(); const result = planTileChanges(input, command(), 1, now);
    expect(result.colors.colors[0]).toBe(2);
    expect(result.metadata.pixels['0'].at).toEqual(Timestamp.fromMillis(now));
    expect(result.applied).toEqual(input.pixels);
    expect(input.colors).toBeUndefined();
    expect(result.estimated_bytes).toBeGreaterThan(4096);
  });
  it('does not mutate previously painted snapshots', () => {
    const input = painted();
    const original = Buffer.from(input.colors.colors);
    input.pixels = [{ x: 1, y: 0, color: 3 }];
    const result = planTileChanges(input, command(undefined, now + 1), 1, now + 1);
    expect(result.colors.colors[1]).toBe(3);
    expect(input.colors.colors).toEqual(original);
    expect(Object.keys(input.metadata.pixels)).toHaveLength(1);
  });
  it('uses event ID as a deterministic tiebreaker when dates are equal', () => {
    const low = command('00000000-0000-4000-8000-000000000001');
    const high = command('00000000-0000-4000-8000-000000000002');
    const first = planTileChanges(tile(), high, 1, now);
    const existing = { ...tile(), colors: first.colors, metadata: first.metadata };
    expect(planTileChanges(existing, low, 1, now).applied).toEqual([]);
    expect(planTileChanges(existing, high, 1, now).applied).toEqual([]);
    const lowerFirst = planTileChanges(tile(), low, 1, now);
    expect(planTileChanges({ ...tile(), colors: lowerFirst.colors, metadata: lowerFirst.metadata }, high, 1, now).applied).toHaveLength(1);
  });
  it.each(['colors', 'metadata'] as const)('refuses a missing %s document', (key) => {
    const input = painted(); Reflect.deleteProperty(input, key);
    expect(() => planTileChanges(input, command(), 1, now)).toThrow('Corrupt tile');
  });
  it.each(['canvas_version', 'tx', 'ty', 'region', 'updated_at'] as const)('refuses inconsistent %s', (key) => {
    const input = painted(); Object.assign(input.metadata, { [key]: 'invalid' });
    expect(() => planTileChanges(input, command(), 1, now)).toThrow('Corrupt tile');
  });
  it('refuses missing provenance for a colored pixel', () => {
    const input = painted(); input.metadata.pixels = {};
    expect(() => planTileChanges(input, command(), 1, now)).toThrow('Corrupt tile');
  });
  it('leaves the size estimate to estimateTileBytes on request, with the same value', () => {
    const deferred = planTileChanges(tile(), command('00000000-0000-4000-8000-000000000001'), 1, now, { estimate: false });
    const direct = planTileChanges(tile(), command('00000000-0000-4000-8000-000000000001'), 1, now);
    expect(deferred.estimated_bytes).toBe(0);
    expect(estimateTileBytes(deferred.metadata, deferred.colors.colors)).toBe(direct.estimated_bytes);
  });
  it('trusts documents it planned itself, but still refuses an unpaired tile', () => {
    const input = painted(); input.metadata.pixels = {}; // Would be corrupt if read from Firestore.
    input.pixels = [{ x: 1, y: 0, color: 3 }];
    expect(planTileChanges(input, command(), 1, now, { trusted: true }).applied).toHaveLength(1);
    Reflect.deleteProperty(input, 'metadata');
    expect(() => planTileChanges(input, command(), 1, now, { trusted: true })).toThrow('Corrupt tile');
  });
  it('refuses provenance attached to an untouched pixel', () => {
    const input = painted(); input.colors.colors[0] = 0;
    expect(() => planTileChanges(input, command(), 1, now)).toThrow('Corrupt tile');
  });
});
