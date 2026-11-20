import { randomBytes } from 'node:crypto';
import type { HttpFunction } from '@google-cloud/functions-framework';
import {
  isSessionClaims, JwtError, MAX_SESSION_AGE_SECONDS, serviceAccountKeys, serviceAccountSigner, sessionClaims,
  verifyJwt, type JwtSigner, type KeySource, type SessionIdentity,
} from '@pixelwar/shared/auth';
import { createLogger } from '@pixelwar/shared/observability/logger';
import { authorizeUrl, DiscordError, discordIdentityExchange, type IdentityExchange } from './discord';

// auth-proxy (WEB-02a, ADR-0012), behind API Gateway:
//   GET  /auth/login            Discord authorization URL and a signed, short-lived state
//   POST /auth/exchange         Discord code -> session JWT (Discord token dropped at once)
//   POST /api/session/refresh   new session JWT, the gateway has already validated the current one
// Browser routes: CORS for the frontend origin only, OPTIONS preflights answered here.

const STATE_TTL_SECONDS = 600;
const STATE_SUBJECT = 'oauth-state';
const ROUTES: Record<string, string> = {
  '/auth/login': 'GET',
  '/auth/exchange': 'POST',
  '/api/session/refresh': 'POST',
};

export interface AuthProxyOptions {
  // https://frontend-<project number>.<region>.run.app, the only origin allowed by CORS.
  frontendOrigin?: string;
  clientId?: string;
  // Session signer e-mail: issuer of the session and state JWTs.
  issuer?: string;
  // GCP project id: audience of the session JWT (a dev token is refused in prd).
  audience?: string;
  sign?: JwtSigner;
  keys?: KeySource;
  exchange?: IdentityExchange;
  now?: () => number;
  log?: ReturnType<typeof createLogger>;
}

type Response = Parameters<HttpFunction>[1];

function fail(res: Response, status: number, error: string): void {
  res.status(status).json({ error });
}

function decodeUserInfo(header: string | undefined): Record<string, unknown> | undefined {
  if (!header || header.length > 8192) return undefined;
  try {
    const value: unknown = JSON.parse(Buffer.from(header, 'base64url').toString('utf8'));
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

export function createAuthProxyHandler(options: AuthProxyOptions): HttpFunction {
  const now = options.now ?? Date.now;
  const log = options.log ?? createLogger({ serviceName: 'auth-proxy', projectId: process.env.GOOGLE_CLOUD_PROJECT ?? '' });
  const ready = Boolean(options.frontendOrigin && options.clientId && options.issuer && options.audience &&
    options.sign && options.keys && options.exchange);
  const redirectUri = `${options.frontendOrigin}/auth/callback`;
  const stateAudience = `${options.audience}/oauth-state`;
  const seconds = () => Math.floor(now() / 1000);

  async function issueSession(identity: SessionIdentity, authTime: number) {
    const claims = sessionClaims({ issuer: options.issuer!, audience: options.audience!, identity, authTime, now: seconds() });
    return {
      token: await options.sign!(claims),
      expires_at: new Date(claims.exp * 1000).toISOString(),
      user: { id: identity.uid, name: identity.name },
    };
  }

  return async (req, res): Promise<void> => {
    res.set('Cache-Control', 'no-store');
    const method = ROUTES[req.path];
    if (!method) { fail(res, 404, 'not_found'); return; }

    // CORS: the browser only reads answers addressed to the frontend origin.
    const origin = req.get('Origin');
    const allowed = origin !== undefined && origin === options.frontendOrigin;
    if (allowed) res.set({ 'Access-Control-Allow-Origin': origin, Vary: 'Origin' });
    if (req.method === 'OPTIONS') {
      if (!allowed) { fail(res, 403, 'origin_not_allowed'); return; }
      res.set({
        'Access-Control-Allow-Methods': method,
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        'Access-Control-Max-Age': '600',
      }).status(204).send();
      return;
    }
    if (req.method !== method) { res.set('Allow', method); fail(res, 405, 'method_not_allowed'); return; }
    if (!ready) { fail(res, 503, 'unavailable'); return; }

    try {
      if (req.path === '/auth/login') {
        const issuedAt = seconds();
        const state = await options.sign!({
          iss: options.issuer, aud: stateAudience, sub: STATE_SUBJECT,
          nonce: randomBytes(16).toString('base64url'), iat: issuedAt, exp: issuedAt + STATE_TTL_SECONDS,
        });
        res.status(200).json({
          authorize_url: authorizeUrl(options.clientId!, redirectUri, state),
          state,
          expires_at: new Date((issuedAt + STATE_TTL_SECONDS) * 1000).toISOString(),
        });
        return;
      }

      if (req.path === '/auth/exchange') {
        const body: unknown = req.body;
        const code = typeof body === 'object' && body !== null ? (body as Record<string, unknown>).code : undefined;
        const state = typeof body === 'object' && body !== null ? (body as Record<string, unknown>).state : undefined;
        if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{10,128}$/.test(code) ||
            typeof state !== 'string' || state.length > 4096) {
          fail(res, 400, 'invalid_request'); return;
        }
        try {
          const claims = await verifyJwt(state, { issuer: options.issuer!, audience: stateAudience, keys: options.keys!, now });
          if (claims.sub !== STATE_SUBJECT) throw new JwtError('claims');
        } catch (error) {
          if (!(error instanceof JwtError) || error.reason === 'keys') throw error;
          log('WARNING', 'OAuth state rejected.', { event_type: 'auth.exchange.invalid_state' });
          fail(res, 401, 'invalid_state'); return;
        }
        let identity;
        try {
          identity = await options.exchange!(code, redirectUri);
        } catch (error) {
          if (error instanceof DiscordError && error.reason === 'refused') {
            log('WARNING', 'Discord refused the authorization code.', { event_type: 'auth.exchange.code_refused' });
            fail(res, 401, 'code_refused'); return;
          }
          throw error;
        }
        const session = await issueSession({ uid: identity.id, name: identity.name }, seconds());
        log('INFO', 'Session issued after Discord login.', { event_type: 'auth.exchange.succeeded', user_id: identity.id });
        res.status(200).json(session);
        return;
      }

      // /api/session/refresh: only reachable through the gateway (IAM), which validated the
      // current session JWT and forwards its claims in X-Apigateway-Api-Userinfo.
      const claims = decodeUserInfo(req.get('X-Apigateway-Api-Userinfo'));
      if (!claims || !isSessionClaims(claims)) { fail(res, 401, 'invalid_session'); return; }
      if (seconds() - claims.auth_time >= MAX_SESSION_AGE_SECONDS) {
        fail(res, 401, 'session_expired'); return;
      }
      const session = await issueSession({ uid: claims.sub, name: claims.name }, claims.auth_time);
      log('INFO', 'Session refreshed.', { event_type: 'auth.refresh.succeeded', user_id: claims.sub });
      res.status(200).json(session);
    } catch {
      // Never log the error itself: it could carry a code, a token or an upstream answer.
      log('ERROR', 'Authentication dependency failed.', { event_type: 'auth.dependency_failed' });
      fail(res, 502, 'upstream_unavailable');
    }
  };
}

const issuer = process.env.SESSION_SIGNER;
export const handleAuthProxy = createAuthProxyHandler({
  frontendOrigin: process.env.FRONTEND_ORIGIN,
  clientId: process.env.DISCORD_CLIENT_ID,
  issuer,
  audience: process.env.SESSION_AUDIENCE,
  sign: issuer ? serviceAccountSigner(issuer) : undefined,
  keys: issuer ? serviceAccountKeys(issuer) : undefined,
  exchange: process.env.DISCORD_CLIENT_ID && process.env.DISCORD_CLIENT_SECRET
    ? discordIdentityExchange(process.env.DISCORD_CLIENT_ID, process.env.DISCORD_CLIENT_SECRET)
    : undefined,
});
