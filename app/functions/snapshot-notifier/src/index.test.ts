import { describe, expect, it, vi } from 'vitest';
import type { HttpFunction } from '@google-cloud/functions-framework';
import { NotificationFailure, TOKEN_LIFETIME_MS, textResponse } from '@pixelwar/shared/discord';
import { requestObjectName, snapshotObjectName } from '@pixelwar/shared/snapshot';
import { testApplication } from '../../../testing/discord-proxy-fixtures';
import { finalizePush, snapshotReadySubscription, snapshotsBucket } from '../../../testing/snapshot-fixtures';
import {
  SIGNED_URL_LIFETIME_MS, createSnapshotNotifierHandler, handleSnapshotNotifier, parseFinalizePush, snapshotMessage,
} from './index';

const eventId = '0f8c1f5e-2d3a-8b4c-9d5e-6f7a8b9c0d1e';
const created = Date.parse('2026-11-26T12:00:00.000Z');
const objectName = snapshotObjectName('2026-11-26T12:00:00.000Z', eventId);
const request = {
  schema_version: 1, event_id: eventId, correlation_id: eventId, traceparent: `00-${'1'.repeat(32)}-${'2'.repeat(16)}-01`,
  application_id: testApplication, interaction_token: 'synthetic-interaction-token', created_at: created,
};
const signed = 'https://storage.example.test/snapshots/x.png?X-Goog-Signature=abc';

function setup(overrides: Record<string, unknown> = {}) {
  const readRequest = vi.fn().mockResolvedValue(request);
  const sign = vi.fn().mockResolvedValue(signed);
  const edit = vi.fn().mockResolvedValue('updated');
  const write = vi.fn();
  const now = () => created + 30_000;
  const handler = createSnapshotNotifierHandler({ applicationId: testApplication, subscription: snapshotReadySubscription,
    bucket: snapshotsBucket, readRequest, sign, edit, write, now, ...overrides });
  const invoke = async (body: unknown = finalizePush(objectName), extra: Record<string, unknown> = {}) => {
    const res = { status: vi.fn(), json: vi.fn(), send: vi.fn(), set: vi.fn() };
    res.status.mockReturnValue(res); res.set.mockReturnValue(res);
    await handler({ path: '/', method: 'POST', body, rawBody: Buffer.from(JSON.stringify(body)), ...extra } as unknown as Parameters<HttpFunction>[0],
      res as unknown as Parameters<HttpFunction>[1]);
    return res;
  };
  const logs = () => write.mock.calls.map(([line]) => JSON.parse(line));
  return { readRequest, sign, edit, write, invoke, logs };
}

describe('parseFinalizePush', () => {
  it('keeps the object and its generation', () => {
    expect(parseFinalizePush(finalizePush(objectName), snapshotReadySubscription, snapshotsBucket))
      .toEqual({ message_id: '789', object: objectName, generation: '1764158400000000' });
  });
  it.each([
    { eventType: 'OBJECT_DELETE' }, { payloadFormat: 'NONE' }, { bucketId: 'other' }, { objectId: '' }, { objectGeneration: '0' },
  ])('refuses %j', (changes) => {
    expect(() => parseFinalizePush(finalizePush(objectName, changes), snapshotReadySubscription, snapshotsBucket)).toThrow('invalid_notification');
  });
  it('refuses another subscription or envelope', () => {
    expect(() => parseFinalizePush({ ...finalizePush(objectName), subscription: 'x' }, snapshotReadySubscription, snapshotsBucket)).toThrow();
    expect(() => parseFinalizePush({ subscription: snapshotReadySubscription, message: {} }, snapshotReadySubscription, snapshotsBucket)).toThrow();
  });
});

describe('snapshot-notifier (BOT-07b)', () => {
  it('signs a limited URL of the image and posts it in the deferred answer', async () => {
    const { invoke, readRequest, sign, edit, logs } = setup();
    expect((await invoke()).status).toHaveBeenCalledWith(204);
    expect(readRequest).toHaveBeenCalledWith(eventId);
    expect(sign).toHaveBeenCalledWith(objectName, created + 30_000 + SIGNED_URL_LIFETIME_MS);
    expect(edit).toHaveBeenCalledWith(
      { application_id: testApplication, interaction_token: 'synthetic-interaction-token', created_at: created },
      textResponse(snapshotMessage(signed, created)));
    expect(snapshotMessage(signed, created)).toBe(`Snapshot du 26 novembre 2026 à 13:00:00 : ${signed}\nLien valable 24 heures.`);
    expect(logs().some((line) => line.event_type === 'snapshot_notifier.posted')).toBe(true);
  });

  it('never logs the token nor the signed URL', async () => {
    for (const overrides of [{}, { edit: vi.fn().mockRejectedValue(new Error(signed)) }]) {
      const { invoke, write } = setup(overrides);
      await invoke();
      expect(JSON.stringify(write.mock.calls)).not.toContain('synthetic-interaction-token');
      expect(JSON.stringify(write.mock.calls)).not.toContain('X-Goog-Signature');
    }
  });

  it('edits the same message again for a duplicate notification', async () => {
    const { invoke, edit } = setup();
    await invoke(); await invoke();
    expect(edit).toHaveBeenCalledTimes(2);
    expect(edit.mock.calls[0][0]).toEqual(edit.mock.calls[1][0]); // Same @original: never a second message.
  });

  it('ignores the request objects and anything that is not a snapshot', async () => {
    const { invoke, readRequest, logs } = setup();
    expect((await invoke(finalizePush(requestObjectName(eventId)))).status).toHaveBeenCalledWith(204);
    expect(readRequest).not.toHaveBeenCalled();
    expect(logs()[0].event_type).toBe('snapshot_notifier.ignored');
  });

  it.each([
    [null, 'snapshot_notifier.request_missing'], [{ ...request, interaction_token: '' }, 'snapshot_notifier.request_invalid'],
    [{ ...request, application_id: '987654321098765432' }, 'snapshot_notifier.request_invalid'],
    [{ ...request, event_id: '1f8c1f5e-2d3a-8b4c-9d5e-6f7a8b9c0d1e', correlation_id: '1f8c1f5e-2d3a-8b4c-9d5e-6f7a8b9c0d1e' }, 'snapshot_notifier.request_invalid'],
  ])('acknowledges a missing or unusable request without retry: %j', async (stored, eventType) => {
    const { invoke, edit, logs } = setup({ readRequest: vi.fn().mockResolvedValue(stored) });
    expect((await invoke()).status).toHaveBeenCalledWith(204);
    expect(edit).not.toHaveBeenCalled();
    expect(logs()[0].event_type).toBe(eventType);
  });

  it('retries when the request cannot be read', async () => {
    const { invoke, logs } = setup({ readRequest: vi.fn().mockRejectedValue(new Error('denied')) });
    expect((await invoke()).status).toHaveBeenCalledWith(503);
    expect(logs()[0]).toMatchObject({ severity: 'ERROR', event_type: 'snapshot_notifier.failed' });
  });

  it('does not sign once the interaction token has expired', async () => {
    const { invoke, sign } = setup({ now: () => created + TOKEN_LIFETIME_MS });
    expect((await invoke()).status).toHaveBeenCalledWith(204);
    expect(sign).not.toHaveBeenCalled();
  });

  it.each(['expired', 'unknown_interaction'])('acknowledges an answer Discord no longer accepts (%s)', async (outcome) => {
    const { invoke } = setup({ edit: vi.fn().mockResolvedValue(outcome) });
    expect((await invoke()).status).toHaveBeenCalledWith(204);
  });

  it('asks for a retry when Discord fails, with its Retry-After', async () => {
    const { invoke, logs } = setup({ edit: vi.fn().mockRejectedValue(new NotificationFailure('rate_limited', 429, 3)) });
    const res = await invoke();
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.set).toHaveBeenCalledWith('Retry-After', '3');
    expect(logs().at(-1)).toMatchObject({ event_type: 'snapshot_notifier.failed', reason: 'rate_limited', http_status: 429 });
  });

  it('quarantines an invalid notification, and refuses other paths, methods, sizes and missing configuration', async () => {
    const { invoke, logs } = setup();
    expect((await invoke(finalizePush(objectName, { bucketId: 'other' }))).status).toHaveBeenCalledWith(400);
    expect(logs()[0].event_type).toBe('snapshot_notifier.message.invalid');
    expect((await invoke(finalizePush(objectName), { path: '/x' })).status).toHaveBeenCalledWith(404);
    expect((await invoke(finalizePush(objectName), { method: 'GET' })).status).toHaveBeenCalledWith(405);
    expect((await invoke(finalizePush(objectName), { rawBody: Buffer.alloc(65 * 1024) })).status).toHaveBeenCalledWith(413);
    expect((await setup({ sign: undefined }).invoke()).status).toHaveBeenCalledWith(503);
    const res = { status: vi.fn(), json: vi.fn() }; res.status.mockReturnValue(res);
    await handleSnapshotNotifier({ path: '/', method: 'POST' } as Parameters<HttpFunction>[0], res as unknown as Parameters<HttpFunction>[1]);
    expect(res.status).toHaveBeenCalledWith(503);
  });
});
