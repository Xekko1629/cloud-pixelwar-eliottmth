import { randomUUID } from 'node:crypto';
import { Timestamp } from '@google-cloud/firestore';
import { describe, expect, it, vi } from 'vitest';
import {
  assertNotFuture, drawOptions, firestorePixel, MAX_FUTURE_SKEW_MS,
  prepareDraw, processingTime, RESULT_RETENTION_MS, storedResult, type DrawCommand, type DrawResult,
} from './command';
import { processAndPublishDraw } from './transaction';

const now = Date.parse('2026-11-19T10:00:30.000Z');
const input = (): DrawCommand => ({
  event_id: randomUUID(), occurred_at: new Date(now).toISOString(), source: 'web',
  author: { uid: '123456789012345678', name: 'Test user' }, pixels: [{ x: 0, y: 0, color: 2 }],
});
function record(command = prepareDraw(input(), 500)) {
  const result: DrawResult = {
    schema_version: 1, result_id: `draw-result:${command.event_id}`, event_id: command.event_id,
    occurred_at: command.occurred_at, processed_at: new Date(now).toISOString(), source: command.source,
    uid: command.author.uid, canvas_version: 1, type: 'pixel-processed',
    requested_pixels: command.pixels.length, applied_pixels: command.pixels.length, ignored_pixels: 0, regions: ['0_0'],
  };
  return { command, data: { schema_version: 1, event_id: command.event_id, request_digest: command.request_digest, status: 'processed', result } };
}

describe('draw command preparation', () => {
  it('canonicalizes pixel order for stable deduplication and copies business input', () => {
    const command = input(); command.pixels = [{ x: 64, y: 0, color: 1 }, { x: 0, y: 1, color: 2 }];
    const prepared = prepareDraw(command, 500);
    expect(prepared.request_digest).toBe(prepareDraw({ ...command, pixels: [...command.pixels].reverse() }, 500).request_digest);
    command.author.name = 'Changed';
    command.pixels[0].color = 3;
    expect(prepared.author.name).toBe('Test user');
    expect(prepared.pixels.find((p) => p.x === 64)?.color).toBe(1);
    expect(Buffer.isBuffer(firestorePixel(prepared.metadata).eid)).toBe(true);
  });
  it.each([
    { event_id: 'invalid' }, { occurred_at: 'invalid' }, { source: 'other' },
    { author: { uid: 'invalid', name: 'User' } }, { author: { uid: '123', name: '' } },
    { pixels: [] }, { pixels: [{ x: 0.5, y: 0, color: 1 }] },
    { pixels: [{ x: 0, y: 0, color: 0 }] },
    { pixels: [{ x: 0, y: 0, color: 1 }, { x: 0, y: 0, color: 2 }] },
  ])('rejects malformed commands without forwarding input in the error: %j', (changes) => {
    expect(() => prepareDraw({ ...input(), ...changes } as DrawCommand, 500)).toThrow('Malformed draw command');
  });
  it('excludes transport metadata from the digest', () => {
    const command = input();
    expect(prepareDraw({ ...command, token: 'synthetic-secret' } as DrawCommand, 500).request_digest).toBe(prepareDraw(command, 500).request_digest);
  });
});

describe('drawing options and clock', () => {
  it('provides bounded defaults', () => {
    expect(drawOptions({})).toMatchObject({ root: '', max_pixels: 500, max_write_documents: 450, max_estimated_bytes: 8 * 1024 * 1024, delta_ttl_ms: 3_600_000 });
    expect(drawOptions({ root: 'tests/id' }).root).toBe('tests/id');
  });
  it.each(['odd', '/leading/slash', 'tests/id/trailing', 'tests/a.b'])('rejects invalid root %s', (root) => {
    expect(() => drawOptions({ root })).toThrow('root');
  });
  it.each([0, -1, 1.5, Infinity, NaN])('rejects invalid budgets %s', (value) => {
    for (const key of ['max_pixels', 'max_write_documents', 'max_estimated_bytes', 'delta_ttl_ms']) {
      expect(() => drawOptions({ [key]: value })).toThrow('positive safe integers');
    }
  });
  it.each([-1, NaN, Infinity, Number.MAX_SAFE_INTEGER])('rejects invalid processing time %s', (value) => {
    expect(() => processingTime(() => value, 1000)).toThrow('Worker time');
  });
  it('allows the exact future skew boundary, not one millisecond beyond', () => {
    const command = prepareDraw(input(), 500);
    expect(processingTime(() => now, RESULT_RETENTION_MS * 2)).toBe(now);
    expect(() => assertNotFuture(command, now - MAX_FUTURE_SKEW_MS)).not.toThrow();
    expect(() => assertNotFuture(command, now - MAX_FUTURE_SKEW_MS - 1)).toThrow('clock tolerance');
    expect(Timestamp.fromMillis(now).toMillis()).toBe(now);
  });
});

describe('persisted deduplication result', () => {
  it('returns the stored result for the same business input', () => {
    const { command, data } = record();
    expect(storedResult(data, command)).toEqual(data.result);
  });
  it('detects content reuse with the same ID', () => {
    const { command, data } = record();
    expect(() => storedResult({ ...data, request_digest: 'a'.repeat(64) }, command)).toThrow('reused');
  });
  it.each([{ schema_version: 2 }, { event_id: 'other' }, { request_digest: 'bad' }])('rejects malformed records %j', (changes) => {
    const { command, data } = record();
    expect(() => storedResult({ ...data, ...changes }, command)).toThrow('deduplication record');
  });
  it.each([
    { schema_version: 2 }, { result_id: 'other' }, { uid: 'other' }, { source: 'discord' },
    { requested_pixels: 2 }, { regions: null }, { canvas_version: 0 }, { applied_pixels: -1 },
    { ignored_pixels: -1 }, { type: 'other' }, { applied_pixels: 0 },
    { type: 'pixel-rejected', reason: undefined },
  ])('rejects malformed stored decisions %j', (changes) => {
    const { command, data } = record();
    expect(() => storedResult({ ...data, result: { ...data.result, ...changes } }, command)).toThrow('persisted draw result');
  });
  it('does not publish if processing fails', async () => {
    const publish = vi.fn();
    await expect(processAndPublishDraw(async () => { throw new Error('unavailable'); }, publish, input())).rejects.toThrow('unavailable');
    expect(publish).not.toHaveBeenCalled();
  });
});
