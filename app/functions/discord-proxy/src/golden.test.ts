// Reference cases of the discord-proxy contract (ADR-0016): the TypeScript handler must keep
// producing app/testing/golden/discord-proxy.json, and the Go proxy (app/go/discord-proxy)
// must produce the same responses and published events. Regenerate after an intended
// contract change with: UPDATE_GOLDEN=1 npx vitest run functions/discord-proxy/src/golden.test.ts
import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { HttpFunction } from '@google-cloud/functions-framework';
import { describe, expect, it } from 'vitest';
import { createDiscordProxyHandler } from './index';
import { adminInteraction, drawInteraction, testApplication, testNow } from '../../../testing/discord-proxy-fixtures';

const GOLDEN = path.resolve(__dirname, '../../../testing/golden/discord-proxy.json');

// Fixed test seed: Ed25519 signatures are deterministic, so the file is stable. Test only.
const seed = Buffer.alloc(32, 7);
const privateKey = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' });
const publicKey = createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');

interface Case { name: string; method: string; path: string; body?: unknown; raw?: string; timestamp?: string; signature?: string }

const timestamp = String(testNow / 1000);
const withUser = (username: string, roles?: string[]) => {
  const interaction = drawInteraction();
  interaction.member.user.username = username;
  if (roles) interaction.member.roles = roles;
  return interaction;
};
const draw = (changes: (interaction: ReturnType<typeof drawInteraction>) => void) => {
  const interaction = drawInteraction(); changes(interaction); return interaction;
};

const CASES: Case[] = [
  { name: 'ping', method: 'POST', path: '/discord/interactions', body: { type: 1, application_id: testApplication } },
  { name: 'draw', method: 'POST', path: '/discord/interactions', body: drawInteraction() },
  { name: 'draw_long_unicode_name', method: 'POST', path: '/discord/interactions', body: withUser(`${'é'.repeat(40)}🙂`) },
  { name: 'draw_duplicate_unsorted_roles', method: 'POST', path: '/discord/interactions', body: withUser('Synthetic user', ['723456789012345678', '523456789012345678', '723456789012345678']) },
  { name: 'draw_float_integral_value', method: 'POST', path: '/discord/interactions', raw: JSON.stringify(drawInteraction()).replace('"value":3}', '"value":3.0}') },
  { name: 'draw_invalid_color', method: 'POST', path: '/discord/interactions', body: draw((i) => { i.data.options[2].value = 0; }) },
  { name: 'draw_missing_option', method: 'POST', path: '/discord/interactions', body: draw((i) => { i.data.options.pop(); }) },
  { name: 'draw_out_of_range', method: 'POST', path: '/discord/interactions', body: draw((i) => { i.data.options[0].value = 1_000_000_001; }) },
  { name: 'admin_pause', method: 'POST', path: '/discord/interactions', body: adminInteraction('pause') },
  { name: 'admin_ratelimit', method: 'POST', path: '/discord/interactions', body: adminInteraction('ratelimit', [{ type: 6, name: 'user', value: '623456789012345678' }, { type: 4, name: 'limit', value: 5 }]) },
  { name: 'admin_size_bounded', method: 'POST', path: '/discord/interactions', body: adminInteraction('size', [{ type: 4, name: 'width', value: 20_000 }, { type: 4, name: 'height', value: 30_000 }]) },
  { name: 'admin_size_infinite', method: 'POST', path: '/discord/interactions', body: adminInteraction('size') },
  { name: 'admin_size_half', method: 'POST', path: '/discord/interactions', body: adminInteraction('size', [{ type: 4, name: 'width', value: 20_000 }]) },
  { name: 'admin_unknown_subcommand', method: 'POST', path: '/discord/interactions', body: adminInteraction('delete') },
  { name: 'get', method: 'POST', path: '/discord/interactions', body: draw((i) => { i.data.name = 'get'; delete (i.data as { options?: unknown }).options; }) },
  { name: 'get_empty_options', method: 'POST', path: '/discord/interactions', body: draw((i) => { i.data.name = 'get'; i.data.options = []; }) },
  { name: 'get_with_options', method: 'POST', path: '/discord/interactions', body: draw((i) => { i.data.name = 'get'; }) },
  { name: 'snapshot_unavailable', method: 'POST', path: '/discord/interactions', body: draw((i) => { i.data.name = 'snapshot'; delete (i.data as { options?: unknown }).options; }) },
  { name: 'unsupported_type', method: 'POST', path: '/discord/interactions', body: { ...drawInteraction(), type: 3 } },
  { name: 'other_application', method: 'POST', path: '/discord/interactions', body: { ...drawInteraction(), application_id: '999999999999999999' } },
  { name: 'invalid_json', method: 'POST', path: '/discord/interactions', raw: '{not json' },
  { name: 'json_array', method: 'POST', path: '/discord/interactions', raw: '[]' },
  { name: 'bad_signature', method: 'POST', path: '/discord/interactions', body: drawInteraction(), signature: '0'.repeat(128) },
  { name: 'stale_timestamp', method: 'POST', path: '/discord/interactions', body: drawInteraction(), timestamp: String(testNow / 1000 - 301) },
  { name: 'missing_signature', method: 'POST', path: '/discord/interactions', body: drawInteraction(), signature: '' },
  { name: 'health', method: 'GET', path: '/discord/health' },
  { name: 'health_wrong_method', method: 'POST', path: '/discord/health' },
  { name: 'wrong_path', method: 'POST', path: '/other' },
  { name: 'wrong_method', method: 'GET', path: '/discord/interactions' },
];

async function run(item: Case) {
  const raw = item.raw ?? (item.body === undefined ? '' : JSON.stringify(item.body));
  const ts = item.timestamp ?? timestamp;
  const signature = item.signature ?? sign(null, Buffer.concat([Buffer.from(ts), Buffer.from(raw)]), privateKey).toString('hex');
  const headers: Record<string, string> = { 'X-Signature-Ed25519': signature, 'X-Signature-Timestamp': ts };
  const published: unknown[] = [];
  const handler = createDiscordProxyHandler({
    publicKey, applicationId: testApplication, now: () => testNow,
    publish: async (event) => { published.push(event); }, log: () => undefined,
    telemetry: { request: (_id, work) => work(operation), message: (_n, _a, work) => work(operation) },
  });
  const response: { status: number; body: unknown; allow?: string } = { status: 0, body: null };
  const res = {
    status(code: number) { response.status = code; return res; },
    json(value: unknown) { response.body = value; return res; },
    send() { return res; },
    set(name: string, value: string) { if (name === 'Allow') response.allow = value; return res; },
  };
  await handler({ path: item.path, method: item.method, rawBody: Buffer.from(raw), get: (name: string) => headers[name] } as unknown as Parameters<HttpFunction>[0],
    res as unknown as Parameters<HttpFunction>[1]);
  return {
    name: item.name,
    request: { method: item.method, path: item.path, headers, body: raw },
    response, published: published[0] ?? null,
  };
}

// The handler under test gets a no-op telemetry: the golden file covers the contract only.
const operation = {
  attributes: () => ({ correlation_id: 'golden', traceparent: `00-${'1'.repeat(32)}-${'2'.repeat(16)}-01` }),
  logFields: () => ({}), log: () => undefined, outcome: () => undefined, source: () => undefined,
  drawResult: () => undefined, notificationAge: () => undefined,
};

describe('discord-proxy reference cases (ADR-0016)', () => {
  it('matches app/testing/golden/discord-proxy.json', async () => {
    const actual = {
      comment: 'Generated by functions/discord-proxy/src/golden.test.ts; checked by the TypeScript and Go proxies.',
      public_key: publicKey, application_id: testApplication, now_ms: testNow,
      cases: await Promise.all(CASES.map(run)),
    };
    if (process.env.UPDATE_GOLDEN === '1') writeFileSync(GOLDEN, `${JSON.stringify(actual, null, 2)}\n`);
    expect(actual).toEqual(JSON.parse(readFileSync(GOLDEN, 'utf8')));
  });
});
