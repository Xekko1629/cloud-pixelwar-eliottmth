import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { HttpFunction } from '@google-cloud/functions-framework';
import { createDiscordHelloHandler, handleDiscordHello } from './index';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const hex = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
const now = 1_800_000_000_000;
const command = (value: unknown = 'Benjamin') => ({
  type: 2, data: { type: 1, name: 'hello', options: [{ type: 3, name: 'nom', value }] },
});

function request(body: unknown, changes: Record<string, unknown> = {}, timestamp = String(now / 1000)) {
  const rawBody = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  const signature = sign(null, Buffer.concat([Buffer.from(timestamp), rawBody]), privateKey).toString('hex');
  const headers: Record<string, string> = { 'X-Signature-Ed25519': signature, 'X-Signature-Timestamp': timestamp };
  return {
    path: '/discord/interactions', method: 'POST', rawBody,
    get: (name: string) => headers[name], ...changes,
  } as unknown as Parameters<HttpFunction>[0];
}

function response() {
  const res = { status: vi.fn(), json: vi.fn(), set: vi.fn() };
  res.status.mockReturnValue(res);
  res.set.mockReturnValue(res);
  return res;
}

async function invoke(req: Parameters<HttpFunction>[0], config = {}) {
  const log = vi.fn();
  const handler = createDiscordHelloHandler({ environment: 'dev', publicKey: hex, now: () => now, log, ...config });
  const res = response();
  await handler(req, res as unknown as Parameters<HttpFunction>[1]);
  return { res, log };
}

describe('temporary signed Discord callback', () => {
  it('responds to a correctly signed Discord PING', async () => {
    const { res, log } = await invoke(request({ type: 1 }));
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ type: 1 });
    expect(log).toHaveBeenCalledWith('INFO', expect.stringContaining('first_request=true'), { event_type: 'discord.probe.ping' });
  });

  it.each(['Benjamin', 'Élodie', 'Ada Lovelace', '@everyone'])('reads nom=%s and disables mentions', async (name) => {
    const { res, log } = await invoke(request(command(name)));
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      type: 4, data: { content: `Hello ${name} !`, flags: 0, allowed_mentions: { parse: [] } },
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain(name);
  });

  it('verifies raw bytes rather than the parsed request body', async () => {
    const { res } = await invoke(request(' { "type" : 1 } ', { body: command('Do not trust req.body') }));
    expect(res.json).toHaveBeenCalledWith({ type: 1 });
  });

  it.each([
    { rawBody: Buffer.from('{"type":2}') },
    { rawBody: undefined },
    { get: () => undefined },
    { get: () => 'malformed' },
    { get: (name: string) => name === 'X-Signature-Timestamp' ? String(now / 1000) : '00'.repeat(64) },
  ])('rejects unsigned, tampered or malformed requests before parsing: %j', async (changes) => {
    const { res } = await invoke(request({ type: 1 }, changes));
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).not.toHaveBeenCalledWith({ type: 1 });
  });

  it.each([-301, 301])('rejects signatures outside the five-minute timestamp window: %i', async (offset) => {
    const { res } = await invoke(request({ type: 1 }, {}, String(now / 1000 + offset)));
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it.each(['', ' ', 123, 'a'.repeat(81)])('rejects invalid nom without failing the Discord protocol: %j', async (name) => {
    const { res } = await invoke(request(command(name)));
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ type: 4, data: {
      content: 'Le paramètre nom est obligatoire (1 à 80 caractères).', flags: 64, allowed_mentions: { parse: [] },
    } });
  });

  it.each([undefined, [], [{ type: 4, name: 'nom', value: 1 }], [{ type: 3, name: 'other', value: 'x' }]])(
    'handles missing or wrongly typed options: %j', async (options) => {
      const body = command();
      const { res } = await invoke(request({ ...body, data: { ...body.data, options } }));
      expect(res.json.mock.calls[0][0].data.flags).toBe(64);
    },
  );

  it('answers unavailable business commands honestly instead of executing them', async () => {
    const { res } = await invoke(request({ type: 2, data: { type: 1, name: 'draw' } }));
    expect(res.json.mock.calls[0][0].data).toMatchObject({ flags: 64, content: expect.stringContaining('/hello') });
  });

  it.each(['not JSON', 'null', '[]', '{"type":99}', '{"type":2}'])('rejects signed invalid interactions: %s', async (body) => {
    const { res } = await invoke(request(body));
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it.each([{ environment: 'prd' }, { publicKey: '' }, { publicKey: 'invalid' }])('fails closed for configuration %j', async (config) => {
    const { res } = await invoke(request({ type: 1 }), config);
    expect(res.status).toHaveBeenCalledWith(503);
  });

  it('restricts path and method', async () => {
    expect((await invoke(request({ type: 1 }, { path: '/hello' }))).res.status).toHaveBeenCalledWith(404);
    const { res } = await invoke(request({ type: 1 }, { method: 'GET' }));
    expect(res.set).toHaveBeenCalledWith('Allow', 'POST');
    expect(res.status).toHaveBeenCalledWith(405);
  });

  it('distinguishes the first request and never logs the interaction token or raw body', async () => {
    const log = vi.fn();
    const handler = createDiscordHelloHandler({ environment: 'dev', publicKey: hex, now: () => now, log });
    for (let i = 0; i < 2; i++) {
      await handler(request({ type: 1, token: 'never-log-this' }), response() as unknown as Parameters<HttpFunction>[1]);
    }
    expect(log.mock.calls[1][1]).toContain('first_request=false');
    expect(JSON.stringify(log.mock.calls)).not.toContain('never-log-this');
  });

  it('exports the Functions Framework entry point and fails closed without runtime configuration', async () => {
    const res = response();
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await handleDiscordHello(request({ type: 1 }), res as unknown as Parameters<HttpFunction>[1]);
      expect(res.status).toHaveBeenCalledWith(503);
    } finally { output.mockRestore(); }
  });
});
