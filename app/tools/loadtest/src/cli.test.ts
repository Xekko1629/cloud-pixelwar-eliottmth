import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resultEventId } from '../../../functions/draw-worker/src/result';
import { main, run } from './cli';
import type { RunRecord } from './send';

const token = 'synthetic-session-token';
const env = { PIXELWAR_GATEWAY_URL: 'https://gateway.example.test', PIXELWAR_SESSION_TOKEN: token };
const record: RunRecord = {
  schema_version: 1, started_at: '2026-11-26T15:00:00.000Z', finished_at: '2026-11-26T15:00:01.000Z',
  strokes: 1, pixels_per_stroke: 1, origin: { x: 0, y: 0 },
  results: [{ index: 0, status: 202, sent_at: '2026-11-26T15:00:00.000Z', duration_ms: 10, event_ids: ['a'] }],
};
const sendArgs = (out: string) => ['send', '--strokes', '1', '--pixels', '1', '--x', '0', '--y', '0', '--out', out];
let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'loadtest-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('loadtest cli', () => {
  it('saves the run and prints the logs command, without the token', async () => {
    const out = join(dir, 'run.json'); const lines: string[] = [];
    const send = vi.fn(async () => record);
    await run(sendArgs(out), env, (line) => lines.push(line), send);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ token, strokes: 1, pixels: 1 }));
    expect(JSON.parse(await readFile(out, 'utf8'))).toEqual(record);
    expect(lines[0]).toBe('1/1 strokes accepted, 1 pixels published.');
    expect(lines.join('\n')).toContain('timestamp>="2026-11-26T15:00:00.000Z"');
    expect(lines.join('\n')).not.toContain(token);
  });
  it('refuses to overwrite a previous run before sending anything', async () => {
    const out = join(dir, 'run.json'); await writeFile(out, 'previous');
    const send = vi.fn(async () => record);
    await expect(run(sendArgs(out), env, () => {}, send)).rejects.toThrow('--out must be a new file.');
    expect(send).not.toHaveBeenCalled();
    expect(await readFile(out, 'utf8')).toBe('previous');
  });
  it('validates the settings before creating the run file', async () => {
    const out = join(dir, 'run.json');
    await expect(run(sendArgs(out), { ...env, PIXELWAR_SESSION_TOKEN: '' }, () => {}, vi.fn())).rejects.toThrow('PIXELWAR_SESSION_TOKEN');
    await expect(readFile(out)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('prints the report of a run', async () => {
    const runFile = join(dir, 'run.json'); const logs = join(dir, 'logs.json'); const lines: string[] = [];
    await writeFile(runFile, JSON.stringify(record));
    await writeFile(logs, JSON.stringify([{ timestamp: '2026-11-26T15:00:02.000Z', jsonPayload: { event_type: 'draw.result.published', event_id: resultEventId('a') } }]));
    await run(['report', '--run', runFile, '--logs', logs], {}, (line) => lines.push(line));
    expect(JSON.parse(lines[0])).toMatchObject({ pixels: { processed: 1 }, drain_seconds: 2 });
  });
  it.each([
    [{ schema_version: 2, results: [] }, '[]', 'Not a loadtest run file.'],
    [record, '{}', 'The logs file must be'],
  ])('refuses unexpected files', async (content, logsContent, message) => {
    const runFile = join(dir, 'run.json'); const logs = join(dir, 'logs.json');
    await writeFile(runFile, JSON.stringify(content)); await writeFile(logs, logsContent);
    await expect(run(['report', '--run', runFile, '--logs', logs], {})).rejects.toThrow(message);
  });
  it.each([[[]], [['send', '--strokes']], [['report', '--run', 'a', '--run', 'b']], [['report', '--other', 'a']]])(
    'prints the usage for %j', async (args) => {
      const errors: string[] = [];
      expect(await main(args, env, () => {}, (line) => errors.push(line))).toBe(1);
      expect(errors[0]).toContain('Usage:');
    });
  it('replaces an unexpected error by a fixed text', async () => {
    const errors: string[] = [];
    expect(await main(['report', '--run', join(dir, 'missing'), '--logs', 'x'], env, () => {}, (l) => errors.push(l))).toBe(1);
    expect(errors).toEqual(['Load test failed; no credentials were logged.']);
  });
  it('returns 0 on success', async () => {
    const runFile = join(dir, 'run.json'); const logs = join(dir, 'logs.json');
    await writeFile(runFile, JSON.stringify(record)); await writeFile(logs, '[]');
    expect(await main(['report', '--run', runFile, '--logs', logs], env, () => {})).toBe(0);
  });
});
