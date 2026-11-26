import { ApiError, type ApiClient } from '../api/client';
import { parseSessionResponse, type KeyValueStorage, type SessionStore, type SessionUser } from './session';

// Discord login of the website (WEB-02b, ADR-0012). Contract: app/functions/auth-proxy/README.md.
//   1. GET /auth/login -> { authorize_url, state, expires_at }; keep state, go to Discord.
//   2. Discord -> /auth/callback?code&state; compare state, POST /auth/exchange { code, state }.
//   3. Session JWT kept by SessionStore, renewed before expires_at by a timer.

export const CALLBACK_PATH = '/auth/callback';
export const STATE_KEY = 'pixelwar.oauth_state';

export type AuthState =
  | { status: 'signed-out'; error: AuthErrorCode | null }
  | { status: 'pending' }
  | { status: 'signed-in'; user: SessionUser };

// Messages shown to the user, in French like the rest of the interface.
export const AUTH_ERRORS = {
  unavailable: 'La connexion n’est pas disponible pour le moment.',
  denied: 'Connexion annulée sur Discord.',
  invalid_state: 'Le lien de connexion a expiré ou ne vient pas de cet onglet. Réessaie.',
  code_refused: 'Discord a refusé la connexion. Réessaie.',
  session_expired: 'Ta session a expiré. Reconnecte-toi.',
} as const;
export type AuthErrorCode = keyof typeof AUTH_ERRORS;

interface PendingLogin {
  state: string;
  expiresAt: number;
}

export interface AuthOptions {
  api: ApiClient | null;
  sessions: SessionStore;
  // sessionStorage: the state must come back to the tab that started the login.
  storage: KeyValueStorage | undefined;
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
  // Renew this long before expires_at (ms).
  refreshMargin?: number;
}

function isDiscordAuthorizeUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && (url.hostname === 'discord.com' || url.hostname.endsWith('.discord.com'));
  } catch {
    return false;
  }
}

export class Auth {
  private state: AuthState;
  private readonly listeners = new Set<() => void>();
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, ms: number) => unknown;
  private readonly clearTimer: (timer: unknown) => void;
  private readonly refreshMargin: number;
  private timer: unknown = null;
  private callback: Promise<void> | null = null;

  constructor(private readonly options: AuthOptions) {
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
    this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
    this.refreshMargin = options.refreshMargin ?? 5 * 60_000;
    this.state = this.fromSession(null);
    options.sessions.subscribe(() => this.onSessionChange());
    this.schedule();
  }

  getState = (): AuthState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Asks the gateway for a Discord authorization URL and returns it; the caller navigates. */
  async startLogin(): Promise<string | null> {
    const api = this.options.api;
    if (!api) { this.update({ status: 'signed-out', error: 'unavailable' }); return null; }
    this.update({ status: 'pending' });
    try {
      const body = await api.json<Record<string, unknown>>('/auth/login', undefined, { auth: false });
      const expiresAt = typeof body.expires_at === 'string' ? Date.parse(body.expires_at) : NaN;
      if (typeof body.state !== 'string' || !isDiscordAuthorizeUrl(body.authorize_url) || !Number.isFinite(expiresAt)) {
        throw new Error('invalid_response');
      }
      const pending: PendingLogin = { state: body.state, expiresAt };
      this.options.storage?.setItem(STATE_KEY, JSON.stringify(pending));
      return body.authorize_url;
    } catch {
      // Includes a storage that refuses to write: without the state, the callback would fail.
      this.update({ status: 'signed-out', error: 'unavailable' });
      return null;
    }
  }

  /**
   * Finishes the login on /auth/callback. Runs once per page load even if called twice
   * (React StrictMode): a Discord code can only be exchanged once.
   */
  completeLogin(search: string): Promise<void> {
    this.callback ??= this.doCompleteLogin(search);
    return this.callback;
  }

  signOut(): void {
    // The JWT is stateless: dropping it ends the session for this browser. A copy taken
    // elsewhere stays valid until expires_at (one hour at most).
    this.options.sessions.clear();
    this.update({ status: 'signed-out', error: null });
  }

  private async doCompleteLogin(search: string): Promise<void> {
    const params = new URLSearchParams(search);
    const pending = this.takePendingLogin();
    const code = params.get('code');
    const state = params.get('state');
    if (params.has('error')) { this.update({ status: 'signed-out', error: 'denied' }); return; }
    if (!code || !state || !pending || pending.state !== state || pending.expiresAt <= this.now()) {
      this.update({ status: 'signed-out', error: 'invalid_state' });
      return;
    }
    const api = this.options.api;
    if (!api) { this.update({ status: 'signed-out', error: 'unavailable' }); return; }
    this.update({ status: 'pending' });
    try {
      const body = await api.json('/auth/exchange', { code, state }, { auth: false });
      const session = parseSessionResponse(body);
      if (!session) throw new Error('invalid_response');
      this.options.sessions.set(session);
    } catch (error) {
      const code = error instanceof ApiError ? error.code : '';
      this.update({
        status: 'signed-out',
        error: code === 'invalid_state' || code === 'code_refused' ? code : 'unavailable',
      });
    }
  }

  private takePendingLogin(): PendingLogin | null {
    try {
      const raw = this.options.storage?.getItem(STATE_KEY) ?? null;
      this.options.storage?.removeItem(STATE_KEY);
      const value: unknown = raw ? JSON.parse(raw) : null;
      if (typeof value !== 'object' || value === null) return null;
      const { state, expiresAt } = value as Record<string, unknown>;
      return typeof state === 'string' && typeof expiresAt === 'number' ? { state, expiresAt } : null;
    } catch {
      return null;
    }
  }

  private onSessionChange(): void {
    const session = this.options.sessions.get();
    // A session that disappears without signOut was refused by the gateway.
    if (!session && this.state.status === 'signed-in') {
      this.update({ status: 'signed-out', error: 'session_expired' });
    } else if (session) {
      this.update({ status: 'signed-in', user: session.user });
    }
    this.schedule();
  }

  private fromSession(error: AuthErrorCode | null): AuthState {
    const session = this.options.sessions.get();
    return session ? { status: 'signed-in', user: session.user } : { status: 'signed-out', error };
  }

  // One timer, set to renew the session refreshMargin before it expires.
  private schedule(): void {
    if (this.timer !== null) { this.clearTimer(this.timer); this.timer = null; }
    const session = this.options.sessions.get();
    const api = this.options.api;
    if (!session || !api) return;
    const delay = Math.max(0, session.expiresAt - this.refreshMargin - this.now());
    this.timer = this.setTimer(() => {
      this.timer = null;
      api.refresh().catch(() => {
        // Gateway unreachable: retry in a minute while the session is still valid.
        const current = this.options.sessions.get();
        if (current && this.timer === null) {
          this.timer = this.setTimer(() => { this.timer = null; this.schedule(); }, 60_000);
        }
      });
    }, delay);
  }

  private update(state: AuthState): void {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
}
