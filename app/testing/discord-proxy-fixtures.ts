// Synthetic signed requests only: no real Discord credential is used by tests.
import { generateKeyPairSync, sign } from 'node:crypto';
import type { HttpFunction } from '@google-cloud/functions-framework';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
export const testPublicKey = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
export const testNow = 1_800_000_000_000;
export const testApplication = '123456789012345678';
export function drawInteraction() {
  return {
    type: 2, id: String((BigInt(testNow) - 1420070400000n) << 22n), application_id: testApplication,
    guild_id: '223456789012345678', channel_id: '323456789012345678', token: 'synthetic-interaction-token',
    member: { user: { id: '423456789012345678', username: 'Synthetic user' }, roles: ['523456789012345678'] },
    data: { type: 1, name: 'draw', options: [
      { type: 4, name: 'x', value: -1 }, { type: 4, name: 'y', value: 64 }, { type: 4, name: 'color', value: 3 },
    ] },
  };
}
/** /admin as Discord sends it: the subcommand is one option of type 1 holding its own options. */
export function adminInteraction(subcommand: string, options?: unknown[]) {
  const interaction = drawInteraction();
  return { ...interaction, data: { type: 1, name: 'admin', options: [{ type: 1, name: subcommand, ...(options ? { options } : {}) }] } };
}
export function signedRequest(body: unknown, changes: Record<string, unknown> = {}, timestamp = String(testNow / 1000)) {
  const rawBody = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  const signature = sign(null, Buffer.concat([Buffer.from(timestamp), rawBody]), privateKey).toString('hex');
  const headers: Record<string, string> = { 'X-Signature-Ed25519': signature, 'X-Signature-Timestamp': timestamp };
  return {
    path: '/discord/interactions', method: 'POST', rawBody, get: (name: string) => headers[name], ...changes,
  } as unknown as Parameters<HttpFunction>[0];
}
