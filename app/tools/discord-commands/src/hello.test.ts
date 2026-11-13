import { describe, expect, it, vi } from 'vitest';
import { helloRegistrationPlan, registerHelloCommand, type Target } from './register';
import { run, main } from './cli';

const target: Target = { environment: 'dev', applicationId: '123456789012345678', guildId: '234567890123456789' };
const env = { APP_ENV: 'dev', DISCORD_APPLICATION_ID: target.applicationId, DISCORD_GUILD_ID: target.guildId };

describe('dev-only hello registration', () => {
  it('declares the required string parameter and a guild-only POST', () => {
    expect(helloRegistrationPlan(target)).toMatchObject({
      method: 'POST', url: `https://discord.com/api/v10/applications/${target.applicationId}/guilds/${target.guildId}/commands`,
      commands: [{ name: 'hello', options: [{ type: 3, name: 'nom', required: true, min_length: 1, max_length: 80 }] }],
    });
    expect(() => helloRegistrationPlan({ environment: 'prd', applicationId: target.applicationId })).toThrow('dev-only');
  });

  it('upserts only hello without overwriting the four existing commands', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({ id: '345678901234567890' }));
    await registerHelloCommand(target, 'fake-token', target.applicationId, { fetch, sleep: vi.fn() });
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0][1]).toMatchObject({ method: 'POST', body: JSON.stringify(helloRegistrationPlan(target).commands[0]) });
  });

  it('requires confirmation and forbids prd before any network call', async () => {
    const deps = { fetch: vi.fn(), sleep: vi.fn() };
    await expect(registerHelloCommand(target, 'fake-token', '', deps)).rejects.toThrow('Confirm');
    await expect(registerHelloCommand({ environment: 'prd', applicationId: target.applicationId }, 'fake-token', target.applicationId, deps)).rejects.toThrow('dev-only');
    expect(deps.fetch).not.toHaveBeenCalled();
  });

  it('keeps --hello a dry-run unless --apply is explicitly provided', async () => {
    const print = vi.fn();
    const bulk = vi.fn();
    const hello = vi.fn();
    await run(['--hello'], env, print, bulk, hello);
    expect(JSON.parse(print.mock.calls[0][0])).toMatchObject({ mode: 'dry-run', method: 'POST' });
    expect(hello).not.toHaveBeenCalled();
    expect(bulk).not.toHaveBeenCalled();
    await run(['--hello', '--apply', '--confirm-application-id', target.applicationId], { ...env, DISCORD_BOT_TOKEN: 'fake-token' }, print, bulk, hello);
    expect(hello).toHaveBeenCalledWith(target, 'fake-token', target.applicationId);
    expect(bulk).not.toHaveBeenCalled();
  });

  it('rejects repeated flags and never prints credentials on failure', async () => {
    const report = vi.fn();
    expect(await main(['--hello', '--hello'], { ...env, DISCORD_BOT_TOKEN: 'never-print-me' }, vi.fn(), report)).toBe(1);
    expect(JSON.stringify(report.mock.calls)).not.toContain('never-print-me');
  });
});
