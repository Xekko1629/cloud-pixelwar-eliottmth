import { describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { main, run } from './cli';

const env = { APP_ENV: 'dev', DISCORD_APPLICATION_ID: '123456789012345678', DISCORD_GUILD_ID: '234567890123456789' };

describe('command CLI', () => {
  it('defaults to a dry run without a token or a network call', async () => {
    const print = vi.fn();
    const register = vi.fn();
    await run([], env, print, register);
    expect(register).not.toHaveBeenCalled();
    const plan = JSON.parse(print.mock.calls[0][0]);
    expect(plan.mode).toBe('dry-run');
    expect(plan.commands).toHaveLength(4);
    expect(plan.url).toContain(`/guilds/${env.DISCORD_GUILD_ID}/commands`);
  });
  it('supports prd global preview without exposing credentials', async () => {
    const print = vi.fn();
    await run([], { APP_ENV: 'prd', DISCORD_APPLICATION_ID: env.DISCORD_APPLICATION_ID, DISCORD_BOT_TOKEN: 'hidden' }, print);
    expect(print.mock.calls[0][0]).not.toContain('hidden');
    expect(JSON.parse(print.mock.calls[0][0]).commands[0].contexts).toEqual([0]);
  });
  it('passes apply configuration only to the registration function', async () => {
    const register = vi.fn().mockResolvedValue(undefined);
    const print = vi.fn();
    await run(['--apply', '--confirm-application-id', env.DISCORD_APPLICATION_ID],
      { ...env, DISCORD_BOT_TOKEN: 'hidden' }, print, register);
    expect(register).toHaveBeenCalledWith({ environment: 'dev', applicationId: env.DISCORD_APPLICATION_ID, guildId: env.DISCORD_GUILD_ID }, 'hidden', env.DISCORD_APPLICATION_ID);
    expect(print.mock.calls[0][0]).not.toContain('hidden');
  });
  it('fails on apply without confirmation or credentials', async () => {
    await expect(run(['--apply'], env)).rejects.toThrow('Confirm');
    await expect(run(['--apply', '--confirm-application-id', env.DISCORD_APPLICATION_ID], env)).rejects.toThrow('DISCORD_BOT_TOKEN');
  });
  it.each([
    ['--unknown'], ['--apply', '--apply'], ['--confirm-application-id'],
    ['--confirm-application-id', '123'],
    ['--confirm-application-id', '123', '--confirm-application-id', '456'],
  ].map((args) => ({ args })))('rejects malformed arguments $args', async ({ args }) => {
    await expect(run(args, env)).rejects.toThrow();
  });
  it('makes the executable exit nonzero without exposing secrets on config failure', () => {
    const cwd = fileURLToPath(new URL('../../../', import.meta.url));
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'tools/discord-commands/src/cli.ts'], {
      cwd, env: { ...process.env, APP_ENV: 'invalid', DISCORD_BOT_TOKEN: 'never-echo-this-token' }, encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Discord command registration failed');
    expect(result.stderr).not.toContain('never-echo-this-token');
  });
  it('returns process exit codes and reports only a safe failure message', async () => {
    const print = vi.fn();
    const report = vi.fn();
    expect(await main([], env, print, report)).toBe(0);
    expect(report).not.toHaveBeenCalled();
    expect(await main([], { ...env, APP_ENV: 'never-echo-this-token' }, print, report)).toBe(1);
    expect(report.mock.calls[0][0]).not.toContain('never-echo-this-token');
  });
  it('runs the actual executable in dry-run mode', () => {
    const cwd = fileURLToPath(new URL('../../../', import.meta.url));
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'tools/discord-commands/src/cli.ts'], {
      cwd, env: { ...process.env, ...env, DISCORD_BOT_TOKEN: 'never-echo-this-token' }, encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).mode).toBe('dry-run');
    expect(result.stdout).not.toContain('never-echo-this-token');
  });
});
