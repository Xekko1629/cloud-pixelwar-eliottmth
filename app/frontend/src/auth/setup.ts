import { ApiClient } from '../api/client';
import type { FrontendConfig } from '../config';
import { Auth } from './auth';
import { SessionStore, safeStorage } from './session';

export interface AuthServices {
  // null while the gateway is not published in this environment.
  api: ApiClient | null;
  auth: Auth;
}

/** Builds the session, the HTTP client and the login flow once per page load. */
export function createAuthServices(config: FrontendConfig, target: Pick<Window, 'sessionStorage'> = window): AuthServices {
  const storage = safeStorage(() => target.sessionStorage);
  const sessions = new SessionStore(storage);
  const api = config.gatewayUrl ? new ApiClient({ baseUrl: config.gatewayUrl, sessions }) : null;
  return { api, auth: new Auth({ api, sessions, storage }) };
}
