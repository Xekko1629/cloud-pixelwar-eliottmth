// Session JWT of the website (ADR-0012). The token is ours, signed by session-signer and
// checked by API Gateway: the Discord token never reaches the browser.
//
// Kept in memory and mirrored in sessionStorage so that a reload of the tab keeps the
// user signed in (ADR-0012 §5). sessionStorage dies with the tab, unlike localStorage.

export interface SessionUser {
  id: string;
  name: string;
}

export interface Session {
  token: string;
  // Milliseconds since the epoch.
  expiresAt: number;
  user: SessionUser;
}

export const SESSION_KEY = 'pixelwar.session';

const JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const SNOWFLAKE = /^[1-9][0-9]{0,19}$/;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** Validates the `{ token, expires_at, user }` answer of /auth/exchange and /api/session/refresh. */
export function parseSessionResponse(raw: unknown): Session | null {
  const body = record(raw);
  const user = record(body?.user);
  if (!body || !user) return null;
  const { token, expires_at: expiresAt } = body;
  if (typeof token !== 'string' || token.length > 8192 || !JWT.test(token)) return null;
  if (typeof expiresAt !== 'string') return null;
  const expires = Date.parse(expiresAt);
  if (!Number.isFinite(expires)) return null;
  if (typeof user.id !== 'string' || !SNOWFLAKE.test(user.id)) return null;
  if (typeof user.name !== 'string' || user.name.length === 0 || user.name.length > 80) return null;
  return { token, expiresAt: expires, user: { id: user.id, name: user.name } };
}

// Storage access can throw (private browsing, blocked site data): the session then only
// lives in memory, which still works until the tab is reloaded.
export type KeyValueStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export function safeStorage(get: () => KeyValueStorage | undefined): KeyValueStorage | undefined {
  try {
    return get();
  } catch {
    return undefined;
  }
}

export class SessionStore {
  private session: Session | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly storage: KeyValueStorage | undefined,
    private readonly now: () => number = Date.now,
  ) {
    this.session = this.restore();
  }

  /** The current session, or null once it has expired. */
  get(): Session | null {
    if (this.session && this.session.expiresAt <= this.now()) this.clear();
    return this.session;
  }

  set(session: Session): void {
    this.session = session;
    try {
      this.storage?.setItem(SESSION_KEY, JSON.stringify(session));
    } catch {
      // Memory only.
    }
    this.notify();
  }

  clear(): void {
    const had = this.session !== null;
    this.session = null;
    try {
      this.storage?.removeItem(SESSION_KEY);
    } catch {
      // Nothing stored.
    }
    if (had) this.notify();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  private restore(): Session | null {
    let raw: string | null = null;
    try {
      raw = this.storage?.getItem(SESSION_KEY) ?? null;
    } catch {
      return null;
    }
    if (!raw) return null;
    let stored: unknown;
    try {
      stored = JSON.parse(raw);
    } catch {
      stored = null;
    }
    const value = record(stored);
    const session = value && typeof value.expiresAt === 'number'
      ? parseSessionResponse({ ...value, expires_at: new Date(value.expiresAt).toISOString() })
      : null;
    if (!session || session.expiresAt <= this.now()) {
      try {
        this.storage?.removeItem(SESSION_KEY);
      } catch {
        // Nothing to clean.
      }
      return null;
    }
    return session;
  }
}
