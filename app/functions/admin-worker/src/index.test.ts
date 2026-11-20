import { describe, expect, it, vi } from 'vitest';
import type { HttpFunction } from '@google-cloud/functions-framework';
import { NotificationFailure } from '@pixelwar/shared/discord';
import { adminRole, adminSubscription, admins, eventPush, routedCommand } from '../../../testing/admin-worker-fixtures';
import { testApplication } from '../../../testing/discord-proxy-fixtures';
import { AdminProcessingError } from './admin';
import { adminResponse } from './content';
import { createAdminWorkerHandler, handleAdminWorker } from './index';

const push = (options: unknown = { subcommand: 'pause' }) => eventPush(routedCommand('admin', options), adminSubscription);
function setup(overrides: Record<string, unknown> = {}) {
  const apply = vi.fn().mockResolvedValue({ result: { status: 'applied', subcommand: 'pause' }, replayed: false });
  const edit = vi.fn().mockResolvedValue('updated');
  const purge = vi.fn().mockResolvedValue({ deleted: 3, complete: true });
  const write = vi.fn();
  const handler = createAdminWorkerHandler({ applicationId: testApplication, subscription: adminSubscription, permissions: admins,
    apply, edit, purge, write, ...overrides });
  const invoke = async (body: unknown = push(), extra: Record<string, unknown> = {}) => {
    const res = { status: vi.fn(), json: vi.fn(), send: vi.fn(), set: vi.fn() };
    res.status.mockReturnValue(res); res.set.mockReturnValue(res);
    await handler({ path: '/', method: 'POST', body, rawBody: Buffer.from(JSON.stringify(body)), ...extra } as unknown as Parameters<HttpFunction>[0],
      res as unknown as Parameters<HttpFunction>[1]);
    return res;
  };
  const logs = () => write.mock.calls.map(([line]) => JSON.parse(line));
  return { apply, edit, purge, write, invoke, logs };
}

describe('admin-worker', () => {
  it('applies the command, answers the admin in Discord, then acknowledges', async () => {
    const { invoke, apply, edit, purge, write } = setup();
    const res = await invoke();
    const event = routedCommand('admin', { subcommand: 'pause' });
    expect(apply).toHaveBeenCalledWith(event.event_id, { subcommand: 'pause' }, event.actor.uid);
    expect(edit.mock.calls[0][0]).toMatchObject({ application_id: testApplication, interaction_token: 'synthetic-interaction-token' });
    expect(edit.mock.calls[0][1]).toEqual(adminResponse({ status: 'applied', subcommand: 'pause' }));
    expect(apply.mock.invocationCallOrder[0]).toBeLessThan(edit.mock.invocationCallOrder[0]);
    expect(purge).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(204);
    expect(JSON.stringify(write.mock.calls)).not.toContain('synthetic-interaction-token');
  });

  it('re-checks the allow-list: nothing is applied for an actor outside it', async () => {
    const { invoke, apply, edit } = setup({ permissions: { user_ids: [], role_ids: ['999999999999999999'] } });
    const res = await invoke();
    expect(apply).not.toHaveBeenCalled();
    expect(edit.mock.calls[0][1]).toEqual(adminResponse({ status: 'unauthorized' }));
    expect(res.status).toHaveBeenCalledWith(204);
  });

  it('accepts an admin authorized by role only', async () => {
    const { invoke, apply } = setup({ permissions: { user_ids: [], role_ids: [adminRole] } });
    await invoke();
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('purges old tiles after a clear, once the admin has been answered', async () => {
    const apply = vi.fn().mockResolvedValue({ result: { status: 'applied', subcommand: 'clear', canvas_version: 4 }, replayed: false });
    const { invoke, edit, purge } = setup({ apply });
    const res = await invoke(push({ subcommand: 'clear' }));
    expect(edit.mock.calls[0][1].content).toContain('version 4');
    expect(purge).toHaveBeenCalledWith(4);
    expect(edit.mock.invocationCallOrder[0]).toBeLessThan(purge.mock.invocationCallOrder[0]);
    expect(res.status).toHaveBeenCalledWith(204);
  });

  it('asks for a redelivery when the purge budget is reached, without clearing again', async () => {
    const apply = vi.fn().mockResolvedValue({ result: { status: 'applied', subcommand: 'clear', canvas_version: 4 }, replayed: true });
    const { invoke, logs } = setup({ apply, purge: vi.fn().mockResolvedValue({ deleted: 400, complete: false }) });
    const res = await invoke(push({ subcommand: 'clear' }));
    expect(res.status).toHaveBeenCalledWith(503);
    expect(logs().map((line) => line.event_type)).toContain('admin.purge.retry');
  });

  it('answers 503 with Retry-After when Discord fails before expiry, after the commit', async () => {
    const { invoke, apply } = setup({ edit: vi.fn().mockRejectedValue(new NotificationFailure('rate_limited', 429, 3)) });
    const res = await invoke();
    expect(apply).toHaveBeenCalledTimes(1);
    expect(res.set).toHaveBeenCalledWith('Retry-After', '3');
    expect(res.status).toHaveBeenCalledWith(503);
  });

  it('acknowledges when the interaction token has expired, keeping the change', async () => {
    const { invoke, logs } = setup({ edit: vi.fn().mockResolvedValue('expired') });
    expect((await invoke()).status).toHaveBeenCalledWith(204);
    expect(logs().map((line) => line.event_type)).toContain('admin.notification_expired');
  });

  it('answers the missing configuration without applying anything', async () => {
    const apply = vi.fn().mockResolvedValue({ result: { status: 'rejected', subcommand: 'pause', reason: 'configuration_missing' }, replayed: false });
    const { invoke, edit } = setup({ apply });
    expect((await invoke()).status).toHaveBeenCalledWith(204);
    expect(edit.mock.calls[0][1].content).toContain('Configuration globale absente');
  });

  it.each([
    ['an invalid message', { subscription: 'projects/demo-pixelwar-test/subscriptions/other', message: {} }, undefined, 400],
    ['an event id reused for another subcommand', undefined, new AdminProcessingError('event_id_conflict'), 400],
    ['a Firestore failure', undefined, new Error('stored secret detail'), 503],
  ])('handles %s without leaking the error', async (_case, body, failure, status) => {
    const { invoke, write } = setup(failure ? { apply: vi.fn().mockRejectedValue(failure) } : {});
    expect((await invoke(body ?? push())).status).toHaveBeenCalledWith(status);
    expect(JSON.stringify(write.mock.calls)).not.toContain('stored secret detail');
  });

  it('writes its structured logs to stdout by default', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    try {
      const { invoke } = setup({ write: undefined, telemetry: { message: async (_n: string, _a: unknown, work: (op: unknown) => Promise<void>) =>
        work({ notificationAge: vi.fn(), outcome: vi.fn(), log: vi.fn() }) } });
      expect((await invoke({ subscription: 'projects/demo-pixelwar-test/subscriptions/other', message: {} })).status).toHaveBeenCalledWith(400);
      expect(String(stdout.mock.calls.at(-1)?.[0])).toContain('admin.message.invalid');
    } finally { stdout.mockRestore(); }
  });

  it('refuses other paths, methods, sizes, and an incomplete configuration', async () => {
    const { invoke } = setup();
    expect((await invoke(push(), { path: '/x' })).status).toHaveBeenCalledWith(404);
    expect((await invoke(push(), { method: 'GET' })).status).toHaveBeenCalledWith(405);
    expect((await invoke(push(), { rawBody: Buffer.alloc(128 * 1024 + 1) })).status).toHaveBeenCalledWith(413);
    for (const missing of ['applicationId', 'subscription', 'permissions', 'apply', 'edit', 'purge']) {
      expect((await setup({ [missing]: undefined }).invoke()).status).toHaveBeenCalledWith(503);
    }
    const res = { status: vi.fn(), json: vi.fn(), send: vi.fn(), set: vi.fn() };
    res.status.mockReturnValue(res);
    await handleAdminWorker({ path: '/', method: 'POST', body: push(), rawBody: Buffer.from('{}') } as unknown as Parameters<HttpFunction>[0],
      res as unknown as Parameters<HttpFunction>[1]);
    expect(res.status).toHaveBeenCalledWith(503);
  });
});

describe('admin answers', () => {
  it.each([
    [{ status: 'applied', subcommand: 'resume' }, 'Dessins réactivés.'],
    [{ status: 'applied', subcommand: 'clear', canvas_version: 12000 }, 'Grille effacée : version 12 000.'],
    [{ status: 'applied', subcommand: 'ratelimit', user: '1', limit: 0 }, 'Quota mis à 0 : cet utilisateur ne peut plus dessiner.'],
    [{ status: 'applied', subcommand: 'ratelimit', user: '1', limit: 50 }, 'Quota de cet utilisateur : 50 pixels par minute.'],
    [{ status: 'applied', subcommand: 'size', size: null }, 'La grille est désormais infinie.'],
    [{ status: 'applied', subcommand: 'size', size: { width: 10_000, height: 20_000 } }, 'Grille bornée à 10 000 × 20 000 pixels.'],
  ] as const)('answers %j without mentions', (result, content) => {
    const body = adminResponse(result as never);
    expect(body.content.replace(/ /g, ' ')).toBe(content);
    expect(body.allowed_mentions).toEqual({ parse: [] });
  });
});
