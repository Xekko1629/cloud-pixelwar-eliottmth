import { describe, expect, it, vi } from 'vitest';
import { readTarget, registrationPlan, registerCommands, type Target } from './register';

const target: Target = { environment: 'dev', applicationId: '123456789012345678', guildId: '234567890123456789' };
const token = 'test-credential-never-log';
const fixture = (...responses: Response[]) => ({
  fetch: vi.fn<typeof fetch>().mockImplementation(async () => responses.shift()!),
  sleep: vi.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined),
});
const rateLimit = (seconds: unknown) => Response.json({ retry_after: seconds }, { status: 429 });

describe('registration target', () => {
  it('requires explicit environment, application and dev guild IDs as strings', () => {
    expect(readTarget({ APP_ENV: 'dev', DISCORD_APPLICATION_ID: target.applicationId, DISCORD_GUILD_ID: target.guildId })).toEqual(target);
    expect(readTarget({ APP_ENV: 'prd', DISCORD_APPLICATION_ID: '99999999999999999999' })).toEqual({
      environment: 'prd', applicationId: '99999999999999999999', guildId: undefined,
    });
  });
  it.each([
    {}, { APP_ENV: 'prod' }, { APP_ENV: 'dev' },
    { APP_ENV: 'dev', DISCORD_APPLICATION_ID: target.applicationId },
    { APP_ENV: 'dev', DISCORD_APPLICATION_ID: '../x', DISCORD_GUILD_ID: target.guildId },
    { APP_ENV: 'dev', DISCORD_APPLICATION_ID: target.applicationId, DISCORD_GUILD_ID: '0' },
    { APP_ENV: 'prd', DISCORD_APPLICATION_ID: target.applicationId, DISCORD_GUILD_ID: target.guildId },
    { APP_ENV: 'prd', DISCORD_APPLICATION_ID: target.applicationId, DISCORD_GUILD_ID: '' },
  ])('rejects ambiguous or invalid config: %j', (env) => expect(() => readTarget(env)).toThrow());

  it('builds only the selected scope on the fixed Discord API v10 origin', () => {
    expect(registrationPlan(target).url).toBe(`https://discord.com/api/v10/applications/${target.applicationId}/guilds/${target.guildId}/commands`);
    expect(registrationPlan({ environment: 'prd', applicationId: target.applicationId }).url)
      .toBe(`https://discord.com/api/v10/applications/${target.applicationId}/commands`);
  });
});

describe('bulk overwrite', () => {
  it('uses identical PUT bodies on repeated executions, never an append or delete', async () => {
    const deps = fixture(Response.json([]), Response.json([]));
    await registerCommands(target, token, target.applicationId, deps);
    await registerCommands(target, token, target.applicationId, deps);
    expect(deps.fetch.mock.calls[0][0]).toBe(deps.fetch.mock.calls[1][0]);
    expect(deps.fetch.mock.calls[0][1]?.body).toBe(deps.fetch.mock.calls[1][1]?.body);
    expect(deps.fetch.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
    expect(deps.fetch.mock.calls[0][1]).toMatchObject({
      method: 'PUT', headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' }, redirect: 'error',
      body: JSON.stringify(registrationPlan(target).commands),
    });
    expect(deps.sleep).not.toHaveBeenCalled();
  });

  it.each(['', 'wrong-id'])('requires target confirmation before any network call', async (confirmation) => {
    const deps = fixture();
    await expect(registerCommands(target, token, confirmation, deps)).rejects.toThrow('Confirm');
    expect(deps.fetch).not.toHaveBeenCalled();
  });
  it.each(['', 'bad\ntoken', 'bad token'])('rejects missing or whitespace credentials', async (credential) => {
    const deps = fixture();
    await expect(registerCommands(target, credential, target.applicationId, deps)).rejects.toThrow('DISCORD_BOT_TOKEN');
    expect(deps.fetch).not.toHaveBeenCalled();
  });

  it('waits the fractional retry_after delay on 429', async () => {
    const deps = fixture(rateLimit(0.25), Response.json([]));
    await registerCommands(target, token, target.applicationId, deps);
    expect(deps.sleep).toHaveBeenCalledWith(250);
    expect(deps.fetch).toHaveBeenCalledTimes(2);
  });
  it('prefers the Retry-After header over the response body', async () => {
    const deps = fixture(new Response('not JSON', { status: 429, headers: { 'Retry-After': '1.5' } }), Response.json([]));
    await registerCommands(target, token, target.applicationId, deps);
    expect(deps.sleep).toHaveBeenCalledWith(1_500);
  });
  it('treats an empty Retry-After as absent', async () => {
    const deps = fixture(Response.json({ retry_after: 0 }, { status: 429, headers: { 'Retry-After': '' } }), Response.json([]));
    await registerCommands(target, token, target.applicationId, deps);
    expect(deps.sleep).toHaveBeenCalledWith(1);
  });
  it.each([undefined, null, '1', -1, 61])('refuses invalid or excessive retry delays: %s', async (delay) => {
    const deps = fixture(rateLimit(delay));
    await expect(registerCommands(target, token, target.applicationId, deps)).rejects.toThrow('retry delay');
    expect(deps.fetch).toHaveBeenCalledTimes(1);
    expect(deps.sleep).not.toHaveBeenCalled();
  });
  it('rejects an invalid 429 JSON response safely', async () => {
    const deps = fixture(new Response(token, { status: 429 }));
    await expect(registerCommands(target, token, target.applicationId, deps)).rejects.toThrow('retry delay');
  });
  it('bounds persistent 429 retries', async () => {
    const deps = fixture(...Array.from({ length: 4 }, () => rateLimit(1)));
    await expect(registerCommands(target, token, target.applicationId, deps)).rejects.toThrow('four attempts');
    expect(deps.fetch).toHaveBeenCalledTimes(4);
    expect(deps.sleep).toHaveBeenCalledTimes(3);
  });
  it('retries 5xx with bounded exponential delays', async () => {
    const deps = fixture(new Response('', { status: 500 }), new Response('', { status: 503 }), Response.json([]));
    await registerCommands(target, token, target.applicationId, deps);
    expect(deps.sleep.mock.calls).toEqual([[1_000], [2_000]]);
  });
  it('fails after four 5xx attempts', async () => {
    const deps = fixture(...Array.from({ length: 4 }, () => new Response('', { status: 503 })));
    await expect(registerCommands(target, token, target.applicationId, deps)).rejects.toThrow('HTTP 503');
    expect(deps.fetch).toHaveBeenCalledTimes(4);
  });
  it.each([400, 401, 403, 404])('never retries HTTP %i or reveals its body', async (status) => {
    const deps = fixture(new Response(token, { status }));
    await expect(registerCommands(target, token, target.applicationId, deps)).rejects.toThrow(`HTTP ${status}`);
    expect(deps.fetch).toHaveBeenCalledTimes(1);
    expect(deps.sleep).not.toHaveBeenCalled();
  });
  it('sanitizes network failures and timeouts without blindly retrying', async () => {
    const deps = fixture();
    deps.fetch.mockRejectedValue(new Error(token));
    await expect(registerCommands(target, token, target.applicationId, deps)).rejects.toThrow('failed or timed out');
    expect(deps.fetch).toHaveBeenCalledTimes(1);
  });
});
