import { describe, expect, it, vi } from 'vitest';
import { commandDefinitions } from './definitions';
import { adminRegistrationPlan, registerAdminCommand, type Target } from './register';
import { run } from './cli';

// Same GET then POST/PATCH strategy as --draw (draw.test.ts covers retries and sanitizing).
const target: Target = { environment: 'dev', applicationId: '123456789012345678', guildId: '234567890123456789' };
const env = { APP_ENV: 'dev', DISCORD_APPLICATION_ID: target.applicationId, DISCORD_GUILD_ID: target.guildId };
const token = 'synthetic-bot-token';
const adminId = '345678901234567890';
const draw = { id: '445678901234567890', type: 1, name: 'draw' };
const admin = commandDefinitions(false).find((command) => command.name === 'admin')!;

function setup(catalogue: unknown[]) {
  const fetch = vi.fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(Response.json(catalogue))
    .mockResolvedValueOnce(Response.json({ id: adminId }));
  return { fetch, sleep: vi.fn().mockResolvedValue(undefined) };
}

describe('targeted dev admin registration', () => {
  it('previews only the admin definition, with its subcommands', () => {
    expect(adminRegistrationPlan(target)).toMatchObject({ strategy: 'GET_THEN_POST_OR_PATCH', commands: [admin] });
    expect(admin.options?.map((option) => option.name)).toEqual(['pause', 'resume', 'clear', 'ratelimit', 'size']);
  });
  it('creates only admin, keeping /draw untouched', async () => {
    const deps = setup([draw]);
    await registerAdminCommand(target, token, target.applicationId, deps);
    expect(deps.fetch.mock.calls.map(([, options]) => options!.method)).toEqual(['GET', 'POST']);
    expect(deps.fetch.mock.calls[1][1]).toMatchObject({ body: JSON.stringify(admin) });
  });
  it('patches the existing admin ID only', async () => {
    const deps = setup([draw, { id: adminId, type: 1, name: 'admin' }]);
    await registerAdminCommand(target, token, target.applicationId, deps);
    const { type: _type, ...update } = admin;
    expect(deps.fetch.mock.calls[1]).toEqual([`${adminRegistrationPlan(target).url}/${adminId}`, expect.objectContaining({ method: 'PATCH', body: JSON.stringify(update) })]);
  });
  it('is dev-only', () => {
    expect(() => adminRegistrationPlan({ environment: 'prd', applicationId: target.applicationId })).toThrow('dev-only');
  });
  it('keeps --admin offline and routes an explicit apply only to the admin registration', async () => {
    const print = vi.fn(); const bulk = vi.fn(); const hello = vi.fn(); const drawRegister = vi.fn(); const adminRegister = vi.fn();
    await run(['--admin'], env, print, bulk, hello, drawRegister, adminRegister);
    expect(JSON.parse(print.mock.calls[0][0])).toMatchObject({ mode: 'dry-run', commands: [{ name: 'admin' }] });
    expect(adminRegister).not.toHaveBeenCalled();
    await run(['--admin', '--apply', '--confirm-application-id', target.applicationId], { ...env, DISCORD_BOT_TOKEN: token }, print, bulk, hello, drawRegister, adminRegister);
    expect(adminRegister).toHaveBeenCalledWith(target, token, target.applicationId);
    expect(bulk).not.toHaveBeenCalled(); expect(drawRegister).not.toHaveBeenCalled();
  });
  it.each([['--admin', '--draw'], ['--draw', '--admin'], ['--admin', '--admin']])('rejects incompatible selectors: %j', async (...args) => {
    await expect(run(args, env)).rejects.toThrow('Usage');
  });
});
