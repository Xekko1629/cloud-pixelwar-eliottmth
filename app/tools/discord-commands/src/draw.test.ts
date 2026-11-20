import { describe, expect, it, vi } from 'vitest';
import { commandDefinitions } from './definitions';
import { drawRegistrationPlan, registerDrawCommand, type Target } from './register';
import { main, run } from './cli';

const target: Target = { environment: 'dev', applicationId: '123456789012345678', guildId: '234567890123456789' };
const env = { APP_ENV: 'dev', DISCORD_APPLICATION_ID: target.applicationId, DISCORD_GUILD_ID: target.guildId };
const commandId = '345678901234567890';
const token = 'synthetic-bot-token';
const existing = { id: commandId, type: 1, name: 'draw', application_id: target.applicationId, guild_id: target.guildId };
const hello = { id: '445678901234567890', type: 1, name: 'hello' };

function setup(catalogue: unknown = []) {
  const fetch = vi.fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(Response.json(catalogue))
    .mockResolvedValueOnce(Response.json({ id: commandId }));
  const sleep = vi.fn().mockResolvedValue(undefined);
  return { fetch, sleep };
}

describe('targeted dev draw registration', () => {
  it('previews only the existing draw definition and explicitly leaves POST/PATCH undecided', () => {
    const plan = drawRegistrationPlan(target);
    expect(plan).toEqual({
      url: `https://discord.com/api/v10/applications/${target.applicationId}/guilds/${target.guildId}/commands`,
      strategy: 'GET_THEN_POST_OR_PATCH', commands: [commandDefinitions(false)[0]],
    });
  });
  it('creates only draw after listing the guild catalogue, preserving hello', async () => {
    const deps = setup([hello]);
    await registerDrawCommand(target, token, target.applicationId, deps);
    const url = drawRegistrationPlan(target).url;
    expect(deps.fetch).toHaveBeenCalledTimes(2);
    expect(deps.fetch.mock.calls[0]).toEqual([url, expect.objectContaining({ method: 'GET', headers: expect.objectContaining({ Authorization: `Bot ${token}` }) })]);
    expect(deps.fetch.mock.calls[0][1]).not.toHaveProperty('body');
    expect(deps.fetch.mock.calls[1]).toEqual([url, expect.objectContaining({ method: 'POST', body: JSON.stringify(commandDefinitions(false)[0]), redirect: 'error' })]);
  });
  it('updates only the existing draw ID, without sending a type change', async () => {
    const deps = setup([hello, existing]);
    await registerDrawCommand(target, token, target.applicationId, deps);
    const { type: _type, ...update } = commandDefinitions(false)[0];
    expect(deps.fetch.mock.calls[1]).toEqual([
      `${drawRegistrationPlan(target).url}/${commandId}`,
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify(update) }),
    ]);
    expect(deps.fetch.mock.calls.map(([, options]) => options!.method)).toEqual(['GET', 'PATCH']);
  });
  it('ignores a context-menu command named draw and creates the slash command', async () => {
    const deps = setup([{ ...existing, type: 2 }]);
    await registerDrawCommand(target, token, target.applicationId, deps);
    expect(deps.fetch.mock.calls.map(([, options]) => options!.method)).toEqual(['GET', 'POST']);
  });
  it('uses Discord default type 1 when the optional type is omitted', async () => {
    const { type: _type, ...withoutType } = existing;
    const deps = setup([withoutType]);
    await registerDrawCommand(target, token, target.applicationId, deps);
    expect(deps.fetch.mock.calls[1][1]!.method).toBe('PATCH');
  });
  it('converges to the same draw payload on repeated invocations', async () => {
    const first = setup([]); await registerDrawCommand(target, token, target.applicationId, first);
    const second = setup([existing]); await registerDrawCommand(target, token, target.applicationId, second);
    const created = JSON.parse(first.fetch.mock.calls[1][1]!.body as string);
    const updated = JSON.parse(second.fetch.mock.calls[1][1]!.body as string);
    expect({ ...updated, type: 1 }).toEqual(created);
  });
  it.each([
    { environment: 'prd', applicationId: target.applicationId } as Target,
    { ...target, guildId: undefined },
    { ...target, applicationId: 'invalid' },
  ])('refuses an invalid or prd target before any network call: %j', async (invalid) => {
    const deps = setup();
    await expect(registerDrawCommand(invalid, token, target.applicationId, deps)).rejects.toThrow();
    expect(deps.fetch).not.toHaveBeenCalled();
  });
  it.each([
    [token, ''], [token, 'other'], ['', target.applicationId], ['invalid token', target.applicationId],
  ])('checks confirmation and credentials before GET', async (credential, confirmation) => {
    const deps = setup();
    await expect(registerDrawCommand(target, credential, confirmation, deps)).rejects.toThrow();
    expect(deps.fetch).not.toHaveBeenCalled();
  });
  it.each([
    null, {}, [null], [{}], [{ ...existing, id: '../other' }], [{ ...existing, id: '18446744073709551616' }],
    [{ ...existing, type: 99 }], [{ ...existing, type: null }], [{ ...existing, name: '' }], [{ ...existing, application_id: 'other' }],
    [{ ...existing, guild_id: 'other' }], Array.from({ length: 201 }, () => hello), [existing, existing],
  ])('refuses malformed or ambiguous catalogues without writing: %j', async (catalogue) => {
    const deps = setup(catalogue);
    await expect(registerDrawCommand(target, token, target.applicationId, deps)).rejects.toThrow();
    expect(deps.fetch).toHaveBeenCalledOnce();
  });
  it('sanitizes malformed JSON responses', async () => {
    const deps = setup(); deps.fetch.mockReset().mockResolvedValue(new Response(token));
    await expect(registerDrawCommand(target, token, target.applicationId, deps)).rejects.toThrow('Invalid Discord command catalogue.');
    expect(deps.fetch).toHaveBeenCalledOnce();
  });
  it('respects a rate limit on GET before deciding whether to write', async () => {
    const deps = setup(); deps.fetch.mockReset()
      .mockResolvedValueOnce(new Response(null, { status: 429, headers: { 'Retry-After': '0.5' } }))
      .mockResolvedValueOnce(Response.json([existing]))
      .mockResolvedValueOnce(Response.json({ id: commandId }));
    await registerDrawCommand(target, token, target.applicationId, deps);
    expect(deps.sleep).toHaveBeenCalledWith(500);
    expect(deps.fetch.mock.calls.map(([, options]) => options!.method)).toEqual(['GET', 'GET', 'PATCH']);
  });
  it('retries a transient PATCH failure on the same ID only', async () => {
    const deps = setup(); deps.fetch.mockReset()
      .mockResolvedValueOnce(Response.json([existing]))
      .mockResolvedValueOnce(new Response(token, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    await registerDrawCommand(target, token, target.applicationId, deps);
    expect(deps.sleep).toHaveBeenCalledWith(1000);
    expect(deps.fetch.mock.calls.map(([, options]) => options!.method)).toEqual(['GET', 'PATCH', 'PATCH']);
    expect(deps.fetch.mock.calls[1][0]).toBe(deps.fetch.mock.calls[2][0]);
  });
  it('bounds retries on catalogue reads', async () => {
    const deps = setup(); deps.fetch.mockReset().mockImplementation(async () => new Response(token, { status: 503 }));
    await expect(registerDrawCommand(target, token, target.applicationId, deps)).rejects.toThrow('HTTP 503');
    expect(deps.fetch).toHaveBeenCalledTimes(4);
    expect(deps.fetch.mock.calls.every(([, options]) => options!.method === 'GET')).toBe(true);
  });
  it('does not fall back to POST or bulk PUT when PATCH returns 404', async () => {
    const deps = setup(); deps.fetch.mockReset()
      .mockResolvedValueOnce(Response.json([existing]))
      .mockResolvedValueOnce(new Response(token, { status: 404 }));
    await expect(registerDrawCommand(target, token, target.applicationId, deps)).rejects.toThrow('HTTP 404');
    expect(deps.fetch.mock.calls.map(([, options]) => options!.method)).toEqual(['GET', 'PATCH']);
  });
  it('sanitizes network errors and never continues after an uncertain write', async () => {
    const deps = setup(); deps.fetch.mockReset()
      .mockResolvedValueOnce(Response.json([]))
      .mockRejectedValueOnce(new Error(token));
    await expect(registerDrawCommand(target, token, target.applicationId, deps)).rejects.toThrow('Discord request failed or timed out; verify the target before retrying.');
    expect(deps.fetch).toHaveBeenCalledTimes(2);
  });
  it('keeps --draw offline and routes an explicit apply only to the targeted function', async () => {
    const print = vi.fn(); const bulk = vi.fn(); const helloRegister = vi.fn(); const draw = vi.fn();
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No network allowed'));
    try {
      await run(['--draw'], env, print, bulk, helloRegister, draw);
      expect(JSON.parse(print.mock.calls[0][0])).toMatchObject({ mode: 'dry-run', strategy: 'GET_THEN_POST_OR_PATCH', commands: [{ name: 'draw' }] });
      expect(network).not.toHaveBeenCalled(); expect(draw).not.toHaveBeenCalled();
      await run(['--draw', '--apply', '--confirm-application-id', target.applicationId], { ...env, DISCORD_BOT_TOKEN: token }, print, bulk, helloRegister, draw);
      expect(draw).toHaveBeenCalledWith(target, token, target.applicationId);
      expect(bulk).not.toHaveBeenCalled(); expect(helloRegister).not.toHaveBeenCalled();
      expect(JSON.stringify(print.mock.calls)).not.toContain(token);
    } finally { network.mockRestore(); }
  });
  it.each([['--draw', '--draw'], ['--hello', '--draw'], ['--draw', '--hello']])('rejects incompatible selectors: %j', async (...args) => {
    await expect(run(args, env)).rejects.toThrow('Usage');
  });
  it('refuses prd preview and emits only a safe CLI error', async () => {
    const print = vi.fn(); const report = vi.fn();
    expect(await main(['--draw'], { APP_ENV: 'prd', DISCORD_APPLICATION_ID: target.applicationId, DISCORD_BOT_TOKEN: token }, print, report)).toBe(1);
    expect(print).not.toHaveBeenCalled();
    expect(JSON.stringify(report.mock.calls)).not.toContain(token);
  });
  it('keeps real CLI apply failures free of credentials and raw Discord responses', async () => {
    const network = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(token, { status: 403 }));
    const print = vi.fn(); const report = vi.fn();
    try {
      expect(await main(['--draw', '--apply', '--confirm-application-id', target.applicationId],
        { ...env, DISCORD_BOT_TOKEN: token }, print, report)).toBe(1);
      expect(network).toHaveBeenCalledOnce();
      expect(print).not.toHaveBeenCalled();
      expect(JSON.stringify(report.mock.calls)).not.toContain(token);
    } finally { network.mockRestore(); }
  });
});
