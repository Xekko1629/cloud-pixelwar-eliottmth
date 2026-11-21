// Identity of a browser call authenticated by API Gateway (ADR-0012).
// The gateway validates the session JWT, then forwards its claims, base64-encoded,
// in X-Apigateway-Api-Userinfo; the original Authorization header is replaced by
// the gateway's own token. This header is trustworthy only because run.invoker on
// the proxy is granted to the gateway identity alone (SRV-04b): never call this
// from a function reachable by anyone else.

export const GATEWAY_USERINFO_HEADER = 'X-Apigateway-Api-Userinfo';

const MAX_HEADER_LENGTH = 8192;
// Same contract as the session claims signed by the auth-proxy (isSessionClaims).
const DISCORD_ID = /^[1-9][0-9]{0,19}$/;
const MAX_NAME_LENGTH = 80;

export interface GatewayIdentity {
  /** Discord user id: same author and quota from Discord and from the web. */
  uid: string;
  /** Display name at login time, as signed in the session JWT. */
  name: string;
}

/** Returns undefined for any absent, oversized, malformed or incomplete header. */
export function gatewayIdentity(header: string | undefined): GatewayIdentity | undefined {
  if (typeof header !== 'string' || header.length < 1 || header.length > MAX_HEADER_LENGTH ||
      !/^[A-Za-z0-9+/_-]+={0,2}$/.test(header)) {
    return undefined;
  }
  let claims: unknown;
  try {
    claims = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(header, 'base64url')));
  } catch {
    return undefined;
  }
  if (typeof claims !== 'object' || claims === null || Array.isArray(claims)) return undefined;
  const { sub, name } = claims as Record<string, unknown>;
  if (typeof sub !== 'string' || !DISCORD_ID.test(sub)) return undefined;
  if (typeof name !== 'string' || name.length < 1 || name.length > MAX_NAME_LENGTH) return undefined;
  return { uid: sub, name };
}
