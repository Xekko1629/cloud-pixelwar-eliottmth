import type { FetchLike } from './jwt';

// Signs JWTs with the Google-managed key of a service account (IAM Credentials signJwt).
// No private key ever exists in our code, Secret Manager or a Terraform state (ADR-0012).
// The caller needs roles/iam.serviceAccountTokenCreator on that account only.

export type JwtSigner = (payload: Record<string, unknown>) => Promise<string>;
export type AccessTokenProvider = () => Promise<string>;

const METADATA_TOKEN_URL = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';

/** Access token of the runtime identity, from the metadata server, cached until shortly before expiry. */
export function metadataAccessToken(options: { fetch?: FetchLike; now?: () => number } = {}): AccessTokenProvider {
  const fetchFn = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  let cached: { token: string; expiresAt: number } | undefined;
  return async () => {
    if (cached && cached.expiresAt - 60_000 > now()) return cached.token;
    const response = await fetchFn(METADATA_TOKEN_URL, {
      headers: { 'Metadata-Flavor': 'Google' },
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) throw new Error(`Metadata server answered ${response.status}`);
    const body = await response.json() as { access_token?: unknown; expires_in?: unknown };
    if (typeof body.access_token !== 'string' || typeof body.expires_in !== 'number') {
      throw new Error('Unexpected metadata token response');
    }
    cached = { token: body.access_token, expiresAt: now() + body.expires_in * 1000 };
    return cached.token;
  };
}

export function serviceAccountSigner(
  serviceAccount: string,
  options: { fetch?: FetchLike; accessToken?: AccessTokenProvider } = {},
): JwtSigner {
  const fetchFn = options.fetch ?? fetch;
  const accessToken = options.accessToken ?? metadataAccessToken({ fetch: fetchFn });
  const url = `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(serviceAccount)}:signJwt`;
  return async (payload) => {
    const response = await fetchFn(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ payload: JSON.stringify(payload) }),
      signal: AbortSignal.timeout(5000),
    });
    // Never include the response body: an error message could echo the payload.
    if (!response.ok) throw new Error(`signJwt answered ${response.status}`);
    const body = await response.json() as { signedJwt?: unknown };
    if (typeof body.signedJwt !== 'string') throw new Error('Unexpected signJwt response');
    return body.signedJwt;
  };
}
