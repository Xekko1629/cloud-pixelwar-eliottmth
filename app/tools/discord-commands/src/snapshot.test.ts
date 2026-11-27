import { describe, expect, it, vi } from 'vitest';
import { commandDefinitions } from './definitions';
import { snapshotRegistrationPlan, registerSnapshotCommand, type Target } from './register';
import { run } from './cli';

// Same GET then POST/PATCH strategy as --draw (draw.test.ts covers retries and sanitizing).
const target: Target = { environment: 'dev', applicationId: '123456789012345678', guildId: '234567890123456789' };
const env = { APP_ENV: 'dev', DISCORD_APPLICATION_ID: target.applicationId, DISCORD_GUILD_ID: target.guildId };
const token = 'synthetic-bot-token';
const snapshotId = '345678901234567890';
const draw = { id: '445678901234567890', type: 1, name: 'draw' };
const snapshot = commandDefinitions(false).find((command) => command.name === 'snapshot')!;

function setup(catalogue: unknown[]) {
  const fetch = vi.fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(Response.json(catalogue))
    .mockResolvedValueOnce(Response.json({ id: snapshotId }));
  return { fetch, sleep: vi.fn().mockResolvedValue(undefined) };
}

describe('targeted dev /snapshot registration (BOT-07a)', () => {
  it('previews only the snapshot definition, without options', () => {
    expect(snapshotRegistrationPlan(target)).toMatchObject({ strategy: 'GET_THEN_POST_OR_PATCH', commands: [snapshot] });
    expect(snapshot.options ?? []).toEqual([]);
  });
  it('creates only snapshot, keeping /draw untouched', async () => {
    const deps = setup([draw]);
    await registerSnapshotCommand(target, token, target.applicationId, deps);
    expect(deps.fetch.mock.calls.map(([, options]) => options!.method)).toEqual(['GET', 'POST']);
    expect(deps.fetch.mock.calls[1][1]).toMatchObject({ body: JSON.stringify(snapshot) });
  });
  it('is dev-only', () => {
    expect(() => snapshotRegistrationPlan({ environment: 'prd', applicationId: target.applicationId })).toThrow('dev-only');
  });
  it('keeps --snapshot offline and routes an explicit apply only to the snapshot registration', async () => {
    const print = vi.fn(); const bulk = vi.fn(); const hello = vi.fn(); const drawRegister = vi.fn(); const adminRegister = vi.fn(); const getRegister = vi.fn(); const snapshotRegister = vi.fn();
    await run(['--snapshot'], env, print, bulk, hello, drawRegister, adminRegister, getRegister, snapshotRegister);
    expect(JSON.parse(print.mock.calls[0][0])).toMatchObject({ mode: 'dry-run', commands: [{ name: 'snapshot' }] });
    expect(snapshotRegister).not.toHaveBeenCalled(); expect(getRegister).not.toHaveBeenCalled();
    await run(['--snapshot', '--apply', '--confirm-application-id', target.applicationId], { ...env, DISCORD_BOT_TOKEN: token }, print, bulk, hello, drawRegister, adminRegister, getRegister, snapshotRegister);
    expect(snapshotRegister).toHaveBeenCalledWith(target, token, target.applicationId); expect(getRegister).not.toHaveBeenCalled();
    expect(bulk).not.toHaveBeenCalled(); expect(adminRegister).not.toHaveBeenCalled();
  });
  it.each([['--snapshot', '--admin'], ['--draw', '--snapshot']])('rejects incompatible selectors: %j', async (...args) => {
    await expect(run(args, env)).rejects.toThrow('Usage');
  });
});
