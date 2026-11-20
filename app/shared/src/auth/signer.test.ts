import { describe, expect, it, vi } from 'vitest';
import { metadataAccessToken, serviceAccountSigner } from './signer';
import { isSessionClaims, MAX_SESSION_AGE_SECONDS, SESSION_TTL_SECONDS, sessionClaims } from './session';

function response(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as Response;
}

describe('metadataAccessToken', () => {
  it('reads the runtime token from the metadata server and caches it until shortly before expiry', async () => {
    let time = 0;
    const fetch = vi.fn().mockResolvedValue(response({ access_token: 'ya29.token', expires_in: 3600 }));
    const token = metadataAccessToken({ fetch, now: () => time });
    expect(await token()).toBe('ya29.token');
    time = 3_000_000;
    await token();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]![1]).toMatchObject({ headers: { 'Metadata-Flavor': 'Google' } });
    time = 3_560_000;
    await token();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('fails on an error or an unexpected answer', async () => {
    await expect(metadataAccessToken({ fetch: vi.fn().mockResolvedValue(response({}, false, 500)) })()).rejects.toThrow('500');
    await expect(metadataAccessToken({ fetch: vi.fn().mockResolvedValue(response({ access_token: 1 })) })()).rejects.toThrow('Unexpected');
  });
});

describe('serviceAccountSigner', () => {
  const account = 'session-signer@pixelwar-test.iam.gserviceaccount.com';

  it('calls IAM Credentials signJwt on the account with the JSON payload', async () => {
    const fetch = vi.fn().mockResolvedValue(response({ keyId: 'k1', signedJwt: 'a.b.c' }));
    const sign = serviceAccountSigner(account, { fetch, accessToken: async () => 'ya29.token' });
    expect(await sign({ sub: '1' })).toBe('a.b.c');
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(`https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(account)}:signJwt`);
    expect(init).toMatchObject({ method: 'POST', headers: { Authorization: 'Bearer ya29.token' } });
    expect(JSON.parse(init.body)).toEqual({ payload: '{"sub":"1"}' });
  });

  it('never exposes the answer of a failed call', async () => {
    const fetch = vi.fn().mockResolvedValue(response({ error: { message: 'payload {"sub":"1"}' } }, false, 403));
    const sign = serviceAccountSigner(account, { fetch, accessToken: async () => 't' });
    await expect(sign({ sub: '1' })).rejects.toThrow('signJwt answered 403');
    await expect(serviceAccountSigner(account, { fetch: vi.fn().mockResolvedValue(response({})), accessToken: async () => 't' })({}))
      .rejects.toThrow('Unexpected');
  });
});

describe('session claims', () => {
  it('builds a one-hour session for the Discord user', () => {
    const claims = sessionClaims({
      issuer: 'iss', audience: 'aud', identity: { uid: '123456789012345678', name: 'exemple' }, authTime: 100, now: 200,
    });
    expect(claims).toEqual({ iss: 'iss', aud: 'aud', sub: '123456789012345678', name: 'exemple', iat: 200, exp: 200 + SESSION_TTL_SECONDS, auth_time: 100 });
    expect(isSessionClaims(claims)).toBe(true);
    expect(MAX_SESSION_AGE_SECONDS).toBe(43_200);
  });

  it('recognizes only well-formed session claims', () => {
    const base = { iss: 'i', aud: 'a', sub: '123', iat: 1, exp: 2, name: 'n', auth_time: 1 };
    expect(isSessionClaims(base)).toBe(true);
    expect(isSessionClaims({ ...base, sub: 'abc' })).toBe(false);
    expect(isSessionClaims({ ...base, name: '' })).toBe(false);
    expect(isSessionClaims({ ...base, auth_time: 1.5 })).toBe(false);
  });
});
