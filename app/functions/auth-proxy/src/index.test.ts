import { createSign, generateKeyPairSync } from 'node:crypto';
import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { http } from '@google-cloud/functions-framework';
import { getTestServer } from '@google-cloud/functions-framework/testing';
import { base64UrlEncode, verifyJwt, type KeySource } from '@pixelwar/shared/auth';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DiscordError } from './discord';
import { createAuthProxyHandler, type AuthProxyOptions } from './index';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const ORIGIN = 'https://frontend-123456789012.europe-west1.run.app';
const ISSUER = 'session-signer@pixelwar-test.iam.gserviceaccount.com';
const AUDIENCE = 'pixelwar-test';
const CLIENT_ID = '1100000000000000001';
const USER = '123456789012345678';
const CODE = 'AbCdEf0123456789xyz';
let now = 1_800_000_000_000;

// Same RS256 format as IAM Credentials signJwt, with a local test key.
async function sign(payload: Record<string, unknown>): Promise<string> {
  const input = `${base64UrlEncode(JSON.stringify({ alg: 'RS256', kid: 'k1', typ: 'JWT' }))}.${base64UrlEncode(JSON.stringify(payload))}`;
  const signer = createSign('RSA-SHA256');
  signer.update(input);
  return `${input}.${signer.sign(privateKey).toString('base64url')}`;
}
const keys: KeySource = async (kid) => (kid === 'k1' ? publicKey : undefined);
const exchange = vi.fn();
const log = vi.fn();

const options: AuthProxyOptions = {
  frontendOrigin: ORIGIN, clientId: CLIENT_ID, issuer: ISSUER, audience: AUDIENCE,
  sign: vi.fn(sign), keys, exchange, now: () => now, log,
};

let server: Server;
let base: string;
function serve(name: string, handlerOptions: AuthProxyOptions) {
  http(name, createAuthProxyHandler(handlerOptions));
}
serve('auth-proxy-test', options);
serve('auth-proxy-unconfigured', { frontendOrigin: ORIGIN });

async function start(name: string) {
  const instance = getTestServer(name);
  instance.listen(0, '127.0.0.1');
  await once(instance, 'listening');
  return instance;
}

beforeAll(async () => {
  server = await start('auth-proxy-test');
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});
beforeEach(() => {
  now = 1_800_000_000_000;
  exchange.mockReset().mockResolvedValue({ id: USER, name: 'exemple' });
  log.mockReset();
});

function call(path: string, init: RequestInit = {}) {
  return fetch(`${base}${path}`, { ...init, signal: AbortSignal.timeout(3000) });
}
function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return call(path, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', Origin: ORIGIN, ...headers } });
}
async function login() {
  const response = await call('/auth/login', { headers: { Origin: ORIGIN } });
  return { response, body: await response.json() as { authorize_url: string; state: string; expires_at: string } };
}

describe('GET /auth/login', () => {
  it('returns the Discord authorization URL with the identify scope and a signed state', async () => {
    const { response, body } = await login();
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const url = new URL(body.authorize_url);
    expect(url.origin + url.pathname).toBe('https://discord.com/oauth2/authorize');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: CLIENT_ID, response_type: 'code', scope: 'identify', prompt: 'none',
      redirect_uri: `${ORIGIN}/auth/callback`, state: body.state,
    });
    const claims = await verifyJwt(body.state, { issuer: ISSUER, audience: `${AUDIENCE}/oauth-state`, keys, now: () => now });
    expect(claims.exp - claims.iat).toBe(600);
    expect(body.expires_at).toBe(new Date((claims.exp) * 1000).toISOString());
  });

  it('gives each login a different state', async () => {
    expect((await login()).body.state).not.toBe((await login()).body.state);
  });
});

describe('POST /auth/exchange', () => {
  it('exchanges the code and returns a one-hour session JWT for the Discord user', async () => {
    const { body: { state } } = await login();
    const response = await post('/auth/exchange', { code: CODE, state });
    expect(response.status).toBe(200);
    const body = await response.json() as { token: string; expires_at: string; user: unknown };
    expect(exchange).toHaveBeenCalledWith(CODE, `${ORIGIN}/auth/callback`);
    expect(body.user).toEqual({ id: USER, name: 'exemple' });
    const claims = await verifyJwt(body.token, { issuer: ISSUER, audience: AUDIENCE, keys, now: () => now });
    expect(claims).toMatchObject({ sub: USER, name: 'exemple', auth_time: now / 1000, exp: now / 1000 + 900 });
    expect(log).toHaveBeenCalledWith('INFO', expect.any(String), { event_type: 'auth.exchange.succeeded', user_id: USER });
  });

  it('refuses a missing, forged, expired or misused state before calling Discord', async () => {
    const { body: { state } } = await login();
    const [header, , signature] = state.split('.');
    const forged = `${header}.${base64UrlEncode(JSON.stringify({ iss: ISSUER, aud: `${AUDIENCE}/oauth-state`, sub: 'oauth-state', iat: 1, exp: 9e9 }))}.${signature}`;
    const session = await sign({ iss: ISSUER, aud: AUDIENCE, sub: USER, iat: now / 1000, exp: now / 1000 + 60 });
    const otherSubject = await sign({ iss: ISSUER, aud: `${AUDIENCE}/oauth-state`, sub: 'other', iat: now / 1000, exp: now / 1000 + 60 });
    for (const candidate of [forged, session, otherSubject, 'not-a-jwt']) {
      const response = await post('/auth/exchange', { code: CODE, state: candidate });
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: 'invalid_state' });
    }
    now += 631_000; // 600 s of validity + 30 s of tolerated clock skew
    expect((await post('/auth/exchange', { code: CODE, state })).status).toBe(401);
    expect(exchange).not.toHaveBeenCalled();
  });

  it('validates the request body', async () => {
    const { body: { state } } = await login();
    for (const body of [{}, { code: CODE }, { state }, { code: 'short', state }, { code: `${CODE}&x=1`, state }, { code: CODE, state: 'x'.repeat(4097) }]) {
      expect((await post('/auth/exchange', body)).status).toBe(400);
    }
    expect((await call('/auth/exchange', { method: 'POST', body: 'code=1', headers: { 'Content-Type': 'text/plain' } })).status).toBe(400);
  });

  it('distinguishes a refused code from an unavailable Discord, without leaking details', async () => {
    const { body: { state } } = await login();
    exchange.mockRejectedValueOnce(new DiscordError('refused'));
    const refused = await post('/auth/exchange', { code: CODE, state });
    expect(refused.status).toBe(401);
    expect(await refused.json()).toEqual({ error: 'code_refused' });

    exchange.mockRejectedValueOnce(new Error(`token=secret code=${CODE}`));
    const failed = await post('/auth/exchange', { code: CODE, state });
    expect(failed.status).toBe(502);
    expect(await failed.json()).toEqual({ error: 'upstream_unavailable' });
    expect(JSON.stringify(log.mock.calls)).not.toContain(CODE);
    expect(JSON.stringify(log.mock.calls)).not.toContain('secret');
  });
});

describe('POST /api/session/refresh', () => {
  const userInfo = (claims: Record<string, unknown>) => Buffer.from(JSON.stringify(claims)).toString('base64url');
  const current = (authTime: number) => ({ iss: ISSUER, aud: AUDIENCE, sub: USER, name: 'exemple', iat: authTime, exp: authTime + 3600, auth_time: authTime });

  it('issues a new session with the same identity and login time', async () => {
    const authTime = now / 1000 - 7200;
    const response = await post('/api/session/refresh', {}, { 'X-Apigateway-Api-Userinfo': userInfo(current(authTime)) });
    expect(response.status).toBe(200);
    const { token } = await response.json() as { token: string };
    expect(await verifyJwt(token, { issuer: ISSUER, audience: AUDIENCE, keys, now: () => now }))
      .toMatchObject({ sub: USER, auth_time: authTime, exp: now / 1000 + 900 });
  });

  it('refuses after twelve hours since the Discord login', async () => {
    const response = await post('/api/session/refresh', {}, { 'X-Apigateway-Api-Userinfo': userInfo(current(now / 1000 - 43_200)) });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'session_expired' });
  });

  it('refuses without gateway user info or with malformed claims', async () => {
    for (const header of [undefined, 'not-base64-json', userInfo({ sub: USER }), Buffer.from('[1]').toString('base64url')]) {
      const response = await post('/api/session/refresh', {}, header ? { 'X-Apigateway-Api-Userinfo': header } : {});
      expect(response.status).toBe(401);
    }
  });
});

describe('routing and CORS', () => {
  it('answers the preflight of the frontend origin only', async () => {
    const preflight = await call('/auth/exchange', { method: 'OPTIONS', headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'POST' } });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(preflight.headers.get('access-control-allow-methods')).toBe('POST');
    expect(preflight.headers.get('access-control-allow-headers')).toBe('Authorization, Content-Type');

    const other = await call('/auth/exchange', { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } });
    expect(other.status).toBe(403);
    expect(other.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('never returns CORS headers to another origin', async () => {
    const response = await call('/auth/login', { headers: { Origin: 'https://evil.example' } });
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('rejects unknown paths and wrong methods', async () => {
    expect((await call('/other')).status).toBe(404);
    const wrong = await call('/auth/login', { method: 'POST' });
    expect(wrong.status).toBe(405);
    expect(wrong.headers.get('allow')).toBe('GET');
  });

  it('answers 503 when the deployment is incomplete', async () => {
    const unconfigured = await start('auth-proxy-unconfigured');
    try {
      const port = (unconfigured.address() as AddressInfo).port;
      const response = await fetch(`http://127.0.0.1:${port}/auth/login`, { signal: AbortSignal.timeout(3000) });
      expect(response.status).toBe(503);
    } finally {
      await new Promise<void>((resolve) => unconfigured.close(() => resolve()));
    }
  });

  it('fails closed when the signing service is unavailable', async () => {
    vi.mocked(options.sign!).mockRejectedValueOnce(new Error('signJwt answered 403'));
    const response = await call('/auth/login', { headers: { Origin: ORIGIN } });
    expect(response.status).toBe(502);
  });
});
