import type { FetchLike } from '@pixelwar/shared/auth';

// Discord OAuth2 Authorization Code flow, server side (ADR-0012). The Discord access token
// lives only inside exchangeIdentity: it is used once to read the user id, then dropped.

const API = 'https://discord.com/api/v10';
export const AUTHORIZE_URL = 'https://discord.com/oauth2/authorize';

export interface DiscordIdentity {
  id: string;
  name: string;
}

export class DiscordError extends Error {
  // refused: the code is invalid, expired or already used (the user must log in again).
  // unavailable: Discord or the network failed (temporary).
  constructor(readonly reason: 'refused' | 'unavailable') {
    super(`Discord OAuth2 ${reason}`);
    this.name = 'DiscordError';
  }
}

export type IdentityExchange = (code: string, redirectUri: string) => Promise<DiscordIdentity>;

export function authorizeUrl(clientId: string, redirectUri: string, state: string): string {
  const query = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    scope: 'identify',
    redirect_uri: redirectUri,
    state,
    prompt: 'none',
  });
  return `${AUTHORIZE_URL}?${query.toString()}`;
}

export function discordIdentityExchange(clientId: string, clientSecret: string, fetchFn: FetchLike = fetch): IdentityExchange {
  return async (code, redirectUri) => {
    let tokenResponse: Response;
    try {
      tokenResponse = await fetchFn(`${API}/oauth2/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri,
        }).toString(),
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      throw new DiscordError('unavailable');
    }
    // 400/401: invalid_grant (expired, reused or forged code) or a redirect URI mismatch.
    if (tokenResponse.status === 400 || tokenResponse.status === 401) throw new DiscordError('refused');
    if (!tokenResponse.ok) throw new DiscordError('unavailable');
    const token = await tokenResponse.json() as { access_token?: unknown; token_type?: unknown; scope?: unknown };
    if (typeof token.access_token !== 'string' || token.token_type !== 'Bearer') throw new DiscordError('unavailable');

    let userResponse: Response;
    try {
      userResponse = await fetchFn(`${API}/users/@me`, {
        headers: { Authorization: `Bearer ${token.access_token}` },
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      throw new DiscordError('unavailable');
    }
    if (!userResponse.ok) throw new DiscordError('unavailable');
    const user = await userResponse.json() as { id?: unknown; username?: unknown; global_name?: unknown };
    if (typeof user.id !== 'string' || !/^[1-9][0-9]{0,19}$/.test(user.id) || typeof user.username !== 'string') {
      throw new DiscordError('unavailable');
    }
    const display = typeof user.global_name === 'string' && user.global_name.trim() !== '' ? user.global_name : user.username;
    return { id: user.id, name: display.slice(0, 80) };
  };
}
