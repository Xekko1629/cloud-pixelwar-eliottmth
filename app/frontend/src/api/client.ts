import { parseSessionResponse, type Session, type SessionStore } from '../auth/session';

// The only HTTP client of the frontend toward API Gateway (WEB-02b). Tiles (WEB-03b),
// inspection (WEB-04) and the brush (WEB-05) all go through it, so the Bearer header,
// the session renewal and the reaction to a 401 live in one place.

/** Error answer of the gateway or of a function: `{ error }` and the HTTP status. */
export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(`${status} ${code}`);
    this.name = 'ApiError';
  }
}

export interface ApiClientOptions {
  // Base URL of the gateway, without trailing slash (FrontendConfig.gatewayUrl).
  baseUrl: string;
  sessions: SessionStore;
  fetch?: typeof fetch;
  now?: () => number;
  // Renew the session when less than this remains (ms). The session lasts one hour.
  refreshMargin?: number;
  // Called when the session is gone: refused by the gateway or no longer renewable.
  onSignedOut?: (reason: string) => void;
}

export interface RequestOptions extends Omit<RequestInit, 'headers'> {
  headers?: Record<string, string>;
  // false for the public routes (/auth/login, /auth/exchange). true by default.
  auth?: boolean;
}

export const REFRESH_PATH = '/api/session/refresh';

export class ApiClient {
  private readonly fetch: typeof fetch;
  private readonly now: () => number;
  private readonly refreshMargin: number;
  private refreshing: Promise<Session | null> | null = null;

  constructor(private readonly options: ApiClientOptions) {
    // fetch called as a method of the options object throws "Illegal invocation".
    const fetchImpl = options.fetch ?? globalThis.fetch;
    this.fetch = (input, init) => fetchImpl(input, init);
    this.now = options.now ?? Date.now;
    this.refreshMargin = options.refreshMargin ?? 5 * 60_000;
  }

  /**
   * Sends a request to the gateway. Authenticated calls carry the session JWT, renewed
   * first when it is about to expire; a 401 ends the session. Throws ApiError on any
   * non-2xx answer except 304, which the caller handles (ETag of the tiles).
   */
  async request(path: string, options: RequestOptions = {}): Promise<Response> {
    const { auth = true, headers = {}, ...init } = options;
    const sent: Record<string, string> = { ...headers };
    if (auth) {
      const session = await this.validSession();
      if (!session) throw this.signedOut('no_session');
      sent.Authorization = `Bearer ${session.token}`;
    }
    const response = await this.fetch(`${this.options.baseUrl}${path}`, { ...init, headers: sent });
    if (response.ok || response.status === 304) return response;
    const code = await errorCode(response);
    if (auth && response.status === 401) throw this.signedOut(code);
    throw new ApiError(response.status, code);
  }

  /** Same as request, with a JSON body in and a JSON answer out. */
  async json<T = unknown>(path: string, body?: unknown, options: RequestOptions = {}): Promise<T> {
    const response = await this.request(path, {
      method: body === undefined ? 'GET' : 'POST',
      ...options,
      headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...options.headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return await response.json() as T;
  }

  /**
   * Renews the session now. Concurrent callers share one request. Returns null and ends
   * the session when the gateway refuses it (expired, or Discord login older than 12 h).
   * A network failure keeps the current session: it may still be valid.
   */
  refresh(): Promise<Session | null> {
    this.refreshing ??= this.doRefresh().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  private async doRefresh(): Promise<Session | null> {
    const current = this.options.sessions.get();
    if (!current) return null;
    const response = await this.fetch(`${this.options.baseUrl}${REFRESH_PATH}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${current.token}`, Accept: 'application/json' },
    });
    if (response.status === 401) {
      this.signedOut(await errorCode(response));
      return null;
    }
    if (!response.ok) throw new ApiError(response.status, await errorCode(response));
    const session = parseSessionResponse(await response.json().catch(() => null));
    if (!session) throw new ApiError(response.status, 'invalid_response');
    // Signed out while the request was in flight: do not bring the session back.
    if (this.options.sessions.get()?.token !== current.token) return null;
    this.options.sessions.set(session);
    return session;
  }

  private async validSession(): Promise<Session | null> {
    const session = this.options.sessions.get();
    if (!session || session.expiresAt - this.now() > this.refreshMargin) return session;
    try {
      return await this.refresh();
    } catch {
      // Gateway unreachable: try with the current token while it is still valid.
      return this.options.sessions.get();
    }
  }

  private signedOut(reason: string): ApiError {
    this.options.sessions.clear();
    this.options.onSignedOut?.(reason);
    return new ApiError(401, reason);
  }
}

async function errorCode(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json();
    const error = typeof body === 'object' && body !== null ? (body as Record<string, unknown>).error : undefined;
    if (typeof error === 'string' && /^[a-z_]{1,64}$/.test(error)) return error;
  } catch {
    // Not JSON: API Gateway answers some errors itself.
  }
  return `http_${response.status}`;
}
