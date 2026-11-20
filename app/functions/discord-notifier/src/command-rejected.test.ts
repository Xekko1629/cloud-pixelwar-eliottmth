import { describe, expect, it, vi } from 'vitest';
import type { HttpFunction } from '@google-cloud/functions-framework';
import { commandRejectedSubscription, eventPush, routedCommand } from '../../../testing/admin-worker-fixtures';
import { testApplication, testNow } from '../../../testing/discord-proxy-fixtures';
import { notifierSubscriptions } from '../../../testing/discord-notifier-fixtures';
import { originalResponseContent } from './content';
import { createDiscordNotifierHandler } from './index';
import { InvalidNotice, parseNoticePush, validSubscriptions } from './message';

const subscriptions = { ...notifierSubscriptions, 'command-rejected': commandRejectedSubscription };
const refused = (command = 'admin') => routedCommand(command, command === 'admin' ? { subcommand: 'clear' } : {}, { user_ids: [], role_ids: [] });
const reason = (action: () => unknown) => {
  try { action(); } catch (error) { return error instanceof InvalidNotice ? error.reason : 'other'; }
  return 'accepted';
};

describe('command-rejected notices (BOT-04 refusals)', () => {
  it.each(['admin', 'snapshot'])('decodes a /%s refusal produced by the real router', (command) => {
    const event = refused(command);
    expect(event.type).toBe('command-rejected');
    const notice = parseNoticePush(eventPush(event, commandRejectedSubscription), subscriptions, testApplication);
    expect(notice).toMatchObject({ source: 'discord', event_id: event.event_id, result: { type: 'command-rejected', command } });
    if (notice.source !== 'discord') throw new Error('expected a Discord notice');
    expect(notice.discord.interaction_token).toBe('synthetic-interaction-token');
    expect(originalResponseContent(notice.result)).toEqual({
      content: `La commande /${command} est réservée aux administrateurs. Aucune action n’a été effectuée.`,
      allowed_mentions: { parse: [] }, embeds: [], components: [],
    });
  });

  it('is refused on a notifier that has no command-rejected subscription', () => {
    expect(reason(() => parseNoticePush(eventPush(refused(), commandRejectedSubscription), notifierSubscriptions, testApplication)))
      .toBe('invalid_envelope');
  });

  it('is refused when delivered through a draw result subscription', () => {
    expect(reason(() => parseNoticePush(eventPush(refused(), notifierSubscriptions['pixel-rejected']), subscriptions, testApplication)))
      .toBe('invalid_event');
  });

  it.each([
    ['another reason', (event: Record<string, any>) => ({ ...event, payload: { ...event.payload, reason: 'paused' } })],
    ['another command', (event: Record<string, any>) => ({ ...event, payload: { ...event.payload, command: 'draw' } })],
    ['an extra payload field', (event: Record<string, any>) => ({ ...event, payload: { ...event.payload, options: {} } })],
    ['a web source', (event: Record<string, any>) => ({ ...event, source: 'web' })],
    ['a correlation different from the event', (event: Record<string, any>) => ({ ...event, correlation_id: '11111111-1111-4111-8111-111111111111' })],
  ])('refuses a refusal with %s', (_case, change) => {
    const event = change(refused() as unknown as Record<string, any>);
    expect(reason(() => parseNoticePush(eventPush(event, commandRejectedSubscription), subscriptions, testApplication))).toBe('invalid_event');
  });

  it('refuses a context that belongs to another interaction or application', () => {
    const event = refused() as unknown as Record<string, any>;
    const otherInteraction = { ...event, payload: { ...event.payload, discord: { ...event.payload.discord, interaction_id: '1100000000000000099' } } };
    expect(reason(() => parseNoticePush(eventPush(otherInteraction, commandRejectedSubscription), subscriptions, testApplication)))
      .toBe('invalid_notification');
    expect(reason(() => parseNoticePush(eventPush(event, commandRejectedSubscription), subscriptions, '1000000000000000999')))
      .toBe('invalid_notification');
  });

  it('validates the optional third subscription', () => {
    expect(validSubscriptions(subscriptions)).toBe(true);
    expect(validSubscriptions({ ...subscriptions, 'command-rejected': 'bad' })).toBe(false);
    expect(validSubscriptions({ ...subscriptions, 'command-rejected': notifierSubscriptions['pixel-processed'] })).toBe(false);
  });

  it('answers the refused user through the handler, then acknowledges', async () => {
    const update = vi.fn().mockResolvedValue('updated');
    const write = vi.fn();
    const handler = createDiscordNotifierHandler({ applicationId: testApplication, subscriptions, update, write });
    const body = eventPush(refused(), commandRejectedSubscription);
    const res = { status: vi.fn(), json: vi.fn(), send: vi.fn(), set: vi.fn() };
    res.status.mockReturnValue(res);
    await handler({ path: '/', method: 'POST', body, rawBody: Buffer.from(JSON.stringify(body)) } as unknown as Parameters<HttpFunction>[0],
      res as unknown as Parameters<HttpFunction>[1]);
    expect(res.status).toHaveBeenCalledWith(204);
    expect(update.mock.calls[0][0]).toMatchObject({ result: { type: 'command-rejected', command: 'admin' } });
    expect(update.mock.calls[0][0].discord.created_at).toBe(testNow);
    expect(JSON.stringify(write.mock.calls)).not.toContain('synthetic-interaction-token');
  });
});
