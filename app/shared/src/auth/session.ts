import type { JwtClaims } from './jwt';

// Contract of the web session JWT (ADR-0012), checked by API Gateway (definition "session")
// and by the realtime service. iss = session-signer e-mail, aud = GCP project id.

// 15 min: no individual revocation, so a short lifetime bounds a leaked or signed-out token.
// The frontend renews it before expiry (ADR-0012).
export const SESSION_TTL_SECONDS = 900;
// After this age of the Discord login, /api/session/refresh refuses and the user logs in again.
export const MAX_SESSION_AGE_SECONDS = 12 * 3600;

export interface SessionIdentity {
  // Discord user id: same author and quota from Discord and from the web.
  uid: string;
  // Display name at login time.
  name: string;
}

export interface SessionClaims extends JwtClaims {
  name: string;
  auth_time: number;
}

export function sessionClaims(options: {
  issuer: string;
  audience: string;
  identity: SessionIdentity;
  authTime: number;
  now: number;
}): SessionClaims {
  return {
    iss: options.issuer,
    aud: options.audience,
    sub: options.identity.uid,
    name: options.identity.name,
    iat: options.now,
    exp: options.now + SESSION_TTL_SECONDS,
    auth_time: options.authTime,
  };
}

export function isSessionClaims(claims: Record<string, unknown>): claims is SessionClaims {
  return typeof claims.sub === 'string' && /^[1-9][0-9]{0,19}$/.test(claims.sub) &&
    typeof claims.name === 'string' && claims.name.length > 0 && claims.name.length <= 80 &&
    typeof claims.auth_time === 'number' && Number.isInteger(claims.auth_time);
}
