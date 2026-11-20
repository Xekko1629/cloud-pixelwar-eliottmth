import { createPublicKey, createVerify, type KeyObject } from 'node:crypto';

// JSON Web Tokens signed by a Google service account (IAM Credentials signJwt, RS256).
// Used for the web session (ADR-0012) and the OAuth state: the auth-proxy signs, API Gateway
// and our own services (auth-proxy, realtime) verify against the account's public keys.

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface JwtClaims {
  iss: string;
  aud: string;
  sub: string;
  iat: number;
  exp: number;
  [claim: string]: unknown;
}

export class JwtError extends Error {
  constructor(readonly reason: 'malformed' | 'signature' | 'expired' | 'claims' | 'keys') {
    super(`Invalid token: ${reason}`);
    this.name = 'JwtError';
  }
}

export function base64UrlEncode(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url');
}

function decodeJson(part: string): Record<string, unknown> {
  // Buffer.from silently accepts malformed base64: require the canonical encoding.
  const bytes = Buffer.from(part, 'base64url');
  if (bytes.toString('base64url') !== part) throw new JwtError('malformed');
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new JwtError('malformed');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new JwtError('malformed');
  return value as Record<string, unknown>;
}

/** Public keys of a service account by key id (kid), as published by Google. */
export type KeySource = (kid: string) => Promise<KeyObject | undefined>;

/** Public certificates of a service account, cached; refreshed when an unknown kid shows up. */
export function serviceAccountKeys(
  email: string,
  options: { fetch?: FetchLike; now?: () => number; ttlMs?: number; minRefreshMs?: number } = {},
): KeySource {
  const fetchFn = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const ttl = options.ttlMs ?? 3_600_000;
  const minRefresh = options.minRefreshMs ?? 60_000;
  const url = `https://www.googleapis.com/robot/v1/metadata/x509/${encodeURIComponent(email)}`;
  let keys = new Map<string, KeyObject>();
  let fetchedAt = Number.NEGATIVE_INFINITY;

  async function refresh(): Promise<void> {
    const response = await fetchFn(url, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new JwtError('keys');
    const body: unknown = await response.json();
    if (typeof body !== 'object' || body === null) throw new JwtError('keys');
    const next = new Map<string, KeyObject>();
    for (const [kid, pem] of Object.entries(body)) {
      if (typeof pem === 'string') next.set(kid, createPublicKey(pem));
    }
    keys = next;
    fetchedAt = now();
  }

  return async (kid) => {
    const age = now() - fetchedAt;
    // Rotation: an unknown kid triggers a refresh, at most once per minRefresh.
    if (age > ttl || (!keys.has(kid) && age > minRefresh)) await refresh();
    return keys.get(kid);
  };
}

export interface VerifyOptions {
  issuer: string;
  audience: string;
  keys: KeySource;
  now?: () => number;
  // Tolerated clock skew, in seconds.
  leeway?: number;
}

/** Verifies an RS256 JWT: signature, issuer, audience, issue and expiry dates. */
export async function verifyJwt(token: string, options: VerifyOptions): Promise<JwtClaims> {
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) throw new JwtError('malformed');
  const [encodedHeader, encodedPayload, encodedSignature] = parts as [string, string, string];
  const header = decodeJson(encodedHeader);
  const payload = decodeJson(encodedPayload);
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw new JwtError('malformed');

  const key = await options.keys(header.kid);
  if (!key) throw new JwtError('signature');
  const verifier = createVerify('RSA-SHA256');
  verifier.update(`${encodedHeader}.${encodedPayload}`);
  if (!verifier.verify(key, Buffer.from(encodedSignature, 'base64url'))) throw new JwtError('signature');

  const now = Math.floor((options.now ?? Date.now)() / 1000);
  const leeway = options.leeway ?? 30;
  const { iss, aud, sub, iat, exp } = payload;
  if (typeof exp !== 'number' || typeof iat !== 'number') throw new JwtError('claims');
  if (exp <= now - leeway) throw new JwtError('expired');
  if (iat > now + leeway) throw new JwtError('claims');
  if (iss !== options.issuer || aud !== options.audience || typeof sub !== 'string' || sub === '') {
    throw new JwtError('claims');
  }
  return payload as JwtClaims;
}
