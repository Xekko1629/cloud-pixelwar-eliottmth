import { describe, expect, it, vi } from 'vitest';
import { authorizeUrl, DiscordError, discordIdentityExchange } from './discord';

const REDIRECT = 'https://frontend-123456789012.europe-west1.run.app/auth/callback';

function response(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

describe('authorizeUrl', () => {
  it('requests the identify scope only', () => {
    const url = new URL(authorizeUrl('1100000000000000001', REDIRECT, 'state.jwt'));
    expect(url.searchParams.get('scope')).toBe('identify');
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT);
  });
});

describe('discordIdentityExchange', () => {
  it('exchanges the code, reads the user, and keeps only id and display name', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(response(200, { access_token: 'discord-token', token_type: 'Bearer', scope: 'identify' }))
      .mockResolvedValueOnce(response(200, { id: '123456789012345678', username: 'exemple', global_name: 'Exemple', email: 'x@y' }));
    const identity = await discordIdentityExchange('client', 'secret', fetch)('code123456', REDIRECT);
    expect(identity).toEqual({ id: '123456789012345678', name: 'Exemple' });

    const [tokenUrl, tokenInit] = fetch.mock.calls[0]!;
    expect(tokenUrl).toBe('https://discord.com/api/v10/oauth2/token');
    expect(Object.fromEntries(new URLSearchParams(tokenInit.body))).toEqual({
      client_id: 'client', client_secret: 'secret', grant_type: 'authorization_code', code: 'code123456', redirect_uri: REDIRECT,
    });
    expect(fetch.mock.calls[1]![1]).toMatchObject({ headers: { Authorization: 'Bearer discord-token' } });
  });

  it('falls back to the username without a global name', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(response(200, { access_token: 't', token_type: 'Bearer' }))
      .mockResolvedValueOnce(response(200, { id: '123', username: 'exemple', global_name: null }));
    expect((await discordIdentityExchange('c', 's', fetch)('code123456', REDIRECT)).name).toBe('exemple');
  });

  it('reports a refused code (invalid_grant, redirect mismatch)', async () => {
    for (const status of [400, 401]) {
      const fetch = vi.fn().mockResolvedValue(response(status, { error: 'invalid_grant' }));
      await expect(discordIdentityExchange('c', 's', fetch)('code123456', REDIRECT)).rejects.toEqual(new DiscordError('refused'));
    }
  });

  it('reports Discord as unavailable on network errors and unexpected answers', async () => {
    const cases = [
      vi.fn().mockRejectedValue(new TypeError('fetch failed')),
      vi.fn().mockResolvedValue(response(500, {})),
      vi.fn().mockResolvedValue(response(200, { access_token: 't', token_type: 'mac' })),
      vi.fn().mockResolvedValueOnce(response(200, { access_token: 't', token_type: 'Bearer' })).mockRejectedValueOnce(new TypeError('x')),
      vi.fn().mockResolvedValueOnce(response(200, { access_token: 't', token_type: 'Bearer' })).mockResolvedValueOnce(response(401, {})),
      vi.fn().mockResolvedValueOnce(response(200, { access_token: 't', token_type: 'Bearer' })).mockResolvedValueOnce(response(200, { id: 'x', username: 'u' })),
    ];
    for (const fetch of cases) {
      await expect(discordIdentityExchange('c', 's', fetch)('code123456', REDIRECT)).rejects.toEqual(new DiscordError('unavailable'));
    }
  });
});
