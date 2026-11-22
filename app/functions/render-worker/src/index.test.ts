import { describe, expect, it, vi } from 'vitest';
import type { HttpFunction } from '@google-cloud/functions-framework';
import { NotificationFailure, snowflakeTime, TOKEN_LIFETIME_MS } from '@pixelwar/shared/discord';
import { eventPush, routedCommand } from '../../../testing/admin-worker-fixtures';
import { testApplication } from '../../../testing/discord-proxy-fixtures';
import { IMAGE_FILENAME, renderResponse } from './content';
import { createRenderWorkerHandler, handleRenderWorker } from './index';
import { renderSubscription } from '../../../testing/render-worker-fixtures';
import { StoredDataError, type RenderResult } from './render';

const routed = routedCommand('get', {});
const created = snowflakeTime((routed.payload as { discord: { interaction_id: string } }).discord.interaction_id);
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const image: RenderResult = { kind: 'image', canvas_version: 2,
  image: { png, width: 71, height: 4, scale: 1, area: { min_x: 0, min_y: 0, max_x: 70, max_y: 3 } } };

function setup(overrides: Record<string, unknown> = {}) {
  const render = vi.fn().mockResolvedValue(image);
  const edit = vi.fn().mockResolvedValue('updated');
  const write = vi.fn();
  const handler = createRenderWorkerHandler({ applicationId: testApplication, subscription: renderSubscription,
    render, edit, write, now: () => created + 2000, ...overrides });
  const invoke = async (body: unknown = eventPush(routed, renderSubscription)) => {
    const res = { status: vi.fn(), json: vi.fn(), send: vi.fn(), set: vi.fn() };
    res.status.mockReturnValue(res); res.set.mockReturnValue(res);
    await handler({ path: '/', method: 'POST', body, rawBody: Buffer.from(JSON.stringify(body)) } as unknown as Parameters<HttpFunction>[0],
      res as unknown as Parameters<HttpFunction>[1]);
    return res;
  };
  const logs = () => write.mock.calls.map(([line]) => JSON.parse(line));
  return { render, edit, write, invoke, logs };
}

describe('render-worker (BOT-06)', () => {
  it('renders, attaches the PNG to the deferred answer, then acknowledges', async () => {
    const { invoke, render, edit, write } = setup();
    const res = await invoke();
    expect(render).toHaveBeenCalledTimes(1);
    expect(edit).toHaveBeenCalledWith(expect.objectContaining({ application_id: testApplication, interaction_token: 'synthetic-interaction-token' }),
      renderResponse(image), { filename: IMAGE_FILENAME, data: png });
    expect(res.status).toHaveBeenCalledWith(204);
    expect(JSON.stringify(write.mock.calls)).not.toContain('synthetic-interaction-token');
  });

  it.each([
    [{ kind: 'empty' } as RenderResult, 'La toile est vide'],
    [{ kind: 'too_large', cells: 70_000 } as RenderResult, '/admin size'],
  ])('answers %j with text only', async (result, text) => {
    const { invoke, edit } = setup({ render: vi.fn().mockResolvedValue(result) });
    expect((await invoke()).status).toHaveBeenCalledWith(204);
    expect(edit.mock.calls[0][1].content).toContain(text);
    expect(edit.mock.calls[0][2]).toBeUndefined();
  });

  it('describes the area and the reduction in a fixed sentence', () => {
    const reduced: RenderResult = { kind: 'image', canvas_version: 2,
      image: { png, width: 2048, height: 1024, scale: 8, area: { min_x: -16_384, min_y: 0, max_x: 0, max_y: 8191 } } };
    expect(renderResponse(reduced).content).toBe('Zone peinte de (-16 384, 0) à (0, 8 191), image de 2 048 × 1 024 px, 1 pixel pour 8 × 8 pixels de la grille.');
    expect(renderResponse(reduced).allowed_mentions).toEqual({ parse: [] });
  });

  it('does not render for an interaction whose token has expired', async () => {
    const { invoke, render, edit, logs } = setup({ now: () => created + TOKEN_LIFETIME_MS });
    expect((await invoke()).status).toHaveBeenCalledWith(204);
    expect(render).not.toHaveBeenCalled();
    expect(edit).not.toHaveBeenCalled();
    expect(logs().map((line) => line.event_type)).toContain('render.notification_expired');
  });

  it('acknowledges an answer Discord can no longer show, since a retry never could', async () => {
    const { invoke, logs } = setup({ edit: vi.fn().mockResolvedValue('unknown_interaction') });
    expect((await invoke()).status).toHaveBeenCalledWith(204);
    expect(logs().map((line) => line.event_type)).toContain('render.notification_unknown_interaction');
  });

  it('asks for a redelivery on a storage failure, without leaking the error', async () => {
    const { invoke, logs, edit } = setup({ render: vi.fn().mockRejectedValue(new StoredDataError('synthetic-interaction-token')) });
    const res = await invoke();
    expect(res.status).toHaveBeenCalledWith(503);
    expect(edit).not.toHaveBeenCalled();
    expect(logs()).toContainEqual(expect.objectContaining({ event_type: 'render.failed', reason: 'stored_data' }));
    expect(JSON.stringify(logs())).not.toContain('synthetic-interaction-token');
  });

  it('forwards the Discord Retry-After on a rate limit', async () => {
    const { invoke } = setup({ edit: vi.fn().mockRejectedValue(new NotificationFailure('rate_limited', 429, 7)) });
    const res = await invoke();
    expect(res.set).toHaveBeenCalledWith('Retry-After', '7');
    expect(res.status).toHaveBeenCalledWith(503);
  });

  it('refuses an invalid message with 400 and its reason only', async () => {
    const { invoke, logs, render } = setup();
    const res = await invoke(eventPush({ ...routed, type: 'snapshot-requested' }, renderSubscription));
    expect(res.status).toHaveBeenCalledWith(400);
    expect(render).not.toHaveBeenCalled();
    expect(logs()).toContainEqual(expect.objectContaining({ event_type: 'render.message.invalid', reason: 'invalid_event' }));
  });

  it('fails closed without configuration and only serves POST /', async () => {
    const unconfigured = await setup({ render: undefined }).invoke();
    expect(unconfigured.status).toHaveBeenCalledWith(503);
    const res = { status: vi.fn(), json: vi.fn(), send: vi.fn(), set: vi.fn() };
    res.status.mockReturnValue(res); res.set.mockReturnValue(res);
    await handleRenderWorker({ path: '/', method: 'POST', body: {}, rawBody: Buffer.from('{}') } as unknown as Parameters<HttpFunction>[0],
      res as unknown as Parameters<HttpFunction>[1]);
    expect(res.status).toHaveBeenCalledWith(503);
  });
});
