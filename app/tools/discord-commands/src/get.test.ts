import { describe, expect, it, vi } from 'vitest';
import { commandDefinitions } from './definitions';
import { getRegistrationPlan, registerGetCommand, type Target } from './register';
import { run } from './cli';

// Same GET then POST/PATCH strategy as --draw (draw.test.ts covers retries and sanitizing).
const target: Target = { environment: 'dev', applicationId: '123456789012345678', guildId: '234567890123456789' };
const env = { APP_ENV: 'dev', DISCORD_APPLICATION_ID: target.applicationId, DISCORD_GUILD_ID: target.guildId };
const token = 'synthetic-bot-token';
const getId = '345678901234567890';
const draw = { id: '445678901234567890', type: 1, name: 'draw' };
const get = commandDefinitions(false).find((command) => command.name === 'get')!;

function setup(catalogue: unknown[]) {
  const fetch = vi.fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(Response.json(catalogue))
    .mockResolvedValueOnce(Response.json({ id: getId }));
  return { fetch, sleep: vi.fn().mockResolvedValue(undefined) };
}

describe('targeted dev /get registration (BOT-06)', () => {
  it('previews only the get definition, without options', () => {
    expect(getRegistrationPlan(target)).toMatchObject({ strategy: 'GET_THEN_POST_OR_PATCH', commands: [get] });
    expect(get.options ?? []).toEqual([]);
  });
  it('creates only get, keeping /draw untouched', async () => {
    const deps = setup([draw]);
    await registerGetCommand(target, token, target.applicationId, deps);
    expect(deps.fetch.mock.calls.map(([, options]) => options!.method)).toEqual(['GET', 'POST']);
    expect(deps.fetch.mock.calls[1][1]).toMatchObject({ body: JSON.stringify(get) });
  });
  it('is dev-only', () => {
    expect(() => getRegistrationPlan({ environment: 'prd', applicationId: target.applicationId })).toThrow('dev-only');
  });
  it('keeps --get offline and routes an explicit apply only to the get registration', async () => {
    const print = vi.fn(); const bulk = vi.fn(); const hello = vi.fn(); const drawRegister = vi.fn(); const adminRegister = vi.fn(); const getRegister = vi.fn();
    await run(['--get'], env, print, bulk, hello, drawRegister, adminRegister, getRegister);
    expect(JSON.parse(print.mock.calls[0][0])).toMatchObject({ mode: 'dry-run', commands: [{ name: 'get' }] });
    expect(getRegister).not.toHaveBeenCalled();
    await run(['--get', '--apply', '--confirm-application-id', target.applicationId], { ...env, DISCORD_BOT_TOKEN: token }, print, bulk, hello, drawRegister, adminRegister, getRegister);
    expect(getRegister).toHaveBeenCalledWith(target, token, target.applicationId);
    expect(bulk).not.toHaveBeenCalled(); expect(adminRegister).not.toHaveBeenCalled();
  });
  it.each([['--get', '--admin'], ['--draw', '--get']])('rejects incompatible selectors: %j', async (...args) => {
    await expect(run(args, env)).rejects.toThrow('Usage');
  });
});
