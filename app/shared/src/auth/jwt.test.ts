import { createSign, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { base64UrlEncode, JwtError, serviceAccountKeys, verifyJwt, type KeySource } from './jwt';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const NOW = 1_800_000_000;
const ISSUER = 'session-signer@pixelwar-test.iam.gserviceaccount.com';
const AUDIENCE = 'pixelwar-test';

function sign(payload: Record<string, unknown>, header: Record<string, unknown> = { alg: 'RS256', kid: 'k1', typ: 'JWT' }, key = privateKey) {
  const input = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(payload))}`;
  const signer = createSign('RSA-SHA256');
  signer.update(input);
  return `${input}.${signer.sign(key).toString('base64url')}`;
}

const claims = { iss: ISSUER, aud: AUDIENCE, sub: '123456789012345678', iat: NOW - 10, exp: NOW + 3600 };
const keys: KeySource = async (kid) => (kid === 'k1' ? publicKey : undefined);
const verify = (token: string, overrides: Partial<Parameters<typeof verifyJwt>[1]> = {}) =>
  verifyJwt(token, { issuer: ISSUER, audience: AUDIENCE, keys, now: () => NOW * 1000, ...overrides });

describe('verifyJwt', () => {
  it('accepts a valid token and returns its claims', async () => {
    await expect(verify(sign({ ...claims, name: 'exemple' }))).resolves.toMatchObject({ sub: claims.sub, name: 'exemple' });
  });

  it('refuses a token signed by another key, or with an unknown key id', async () => {
    await expect(verify(sign(claims, undefined, other.privateKey))).rejects.toThrow(new JwtError('signature'));
    await expect(verify(sign(claims, { alg: 'RS256', kid: 'k2' }))).rejects.toThrow(new JwtError('signature'));
  });

  it('refuses a modified payload', async () => {
    const [header, , signature] = sign(claims).split('.');
    const forged = base64UrlEncode(JSON.stringify({ ...claims, sub: '999' }));
    await expect(verify(`${header}.${forged}.${signature}`)).rejects.toThrow(new JwtError('signature'));
  });

  it('refuses other algorithms, including none', async () => {
    await expect(verify(sign(claims, { alg: 'HS256', kid: 'k1' }))).rejects.toThrow(new JwtError('malformed'));
    const unsigned = `${base64UrlEncode(JSON.stringify({ alg: 'none', kid: 'k1' }))}.${base64UrlEncode(JSON.stringify(claims))}.x`;
    await expect(verify(unsigned)).rejects.toThrow(new JwtError('malformed'));
  });

  it('refuses malformed tokens', async () => {
    for (const token of ['', 'a.b', 'a..c', '!!.e30.e30', `${base64UrlEncode('[1]')}.e30.e30`, `${base64UrlEncode('{')}.e30.e30`]) {
      await expect(verify(token)).rejects.toThrow(new JwtError('malformed'));
    }
  });

  it('refuses an expired token, beyond the clock skew', async () => {
    await expect(verify(sign({ ...claims, exp: NOW - 31 }))).rejects.toThrow(new JwtError('expired'));
    await expect(verify(sign({ ...claims, exp: NOW - 5 }))).resolves.toBeDefined();
  });

  it('refuses a token issued in the future, a wrong issuer, audience or subject', async () => {
    await expect(verify(sign({ ...claims, iat: NOW + 120 }))).rejects.toThrow(new JwtError('claims'));
    await expect(verify(sign({ ...claims, iss: 'someone@else.iam.gserviceaccount.com' }))).rejects.toThrow(new JwtError('claims'));
    await expect(verify(sign({ ...claims, aud: 'cloud-pixelwar-prod' }))).rejects.toThrow(new JwtError('claims'));
    await expect(verify(sign({ ...claims, sub: '' }))).rejects.toThrow(new JwtError('claims'));
    await expect(verify(sign({ ...claims, exp: 'later' }))).rejects.toThrow(new JwtError('claims'));
  });
});

describe('serviceAccountKeys', () => {
  function response(body: unknown, ok = true) {
    return { ok, json: async () => body } as Response;
  }

  it('fetches the public certificates of the account once, then serves them from cache', async () => {
    const fetch = vi.fn().mockResolvedValue(response({ k1: publicPem }));
    const source = serviceAccountKeys(ISSUER, { fetch, now: () => 0 });
    expect(await source('k1')).toBeDefined();
    expect(await source('k1')).toBeDefined();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]![0]).toBe(`https://www.googleapis.com/robot/v1/metadata/x509/${encodeURIComponent(ISSUER)}`);
  });

  it('refreshes for an unknown key id, at most once per minimum interval', async () => {
    let time = 0;
    const fetch = vi.fn().mockResolvedValueOnce(response({ k1: publicPem })).mockResolvedValue(response({ k1: publicPem, k2: publicPem }));
    const source = serviceAccountKeys(ISSUER, { fetch, now: () => time });
    await source('k1');
    expect(await source('k2')).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);
    time = 61_000;
    expect(await source('k2')).toBeDefined();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('refreshes after the cache lifetime and fails closed on an error', async () => {
    let time = 0;
    const fetch = vi.fn().mockResolvedValueOnce(response({ k1: publicPem })).mockResolvedValueOnce(response({}, false));
    const source = serviceAccountKeys(ISSUER, { fetch, now: () => time });
    await source('k1');
    time = 3_600_001;
    await expect(source('k1')).rejects.toThrow(new JwtError('keys'));
  });

  it('rejects an unexpected key document', async () => {
    const source = serviceAccountKeys(ISSUER, { fetch: vi.fn().mockResolvedValue(response(null)) });
    await expect(source('k1')).rejects.toThrow(new JwtError('keys'));
  });
});
