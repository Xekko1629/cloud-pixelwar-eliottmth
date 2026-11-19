// Runtime configuration of the deployed environment (ADR-0011). The container writes it
// into /config.js at startup, so the same image runs in dev and prd: nothing here is
// compiled into the bundle, and none of these values is a secret.
export interface FrontendConfig {
  environment: 'dev' | 'prd' | 'local';
  // Base URL of API Gateway, without trailing slash; null until a proxy is published.
  gatewayUrl: string | null;
  // Server-Sent Events service of the deltas (ADR-0013); null until it is deployed.
  realtimeUrl: string | null;
  // Discord OAuth2 client id (public); null until WEB-02b.
  discordClientId: string | null;
}

declare global {
  interface Window {
    __PIXELWAR_CONFIG__?: unknown;
  }
}

const ENVIRONMENTS = new Set(['dev', 'prd', 'local']);

function httpsUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value === '') return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  // http only for a local development server, never for a deployed environment.
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) return null;
  return url.origin + url.pathname.replace(/\/+$/, '');
}

function snowflake(value: unknown): string | null {
  return typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value) ? value : null;
}

/** Validates the raw object of /config.js. Invalid or missing fields fall back to null. */
export function parseConfig(raw: unknown): FrontendConfig {
  const source = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const environment = typeof source.environment === 'string' && ENVIRONMENTS.has(source.environment)
    ? (source.environment as FrontendConfig['environment'])
    : 'local';
  return {
    environment,
    gatewayUrl: httpsUrl(source.gatewayUrl),
    realtimeUrl: httpsUrl(source.realtimeUrl),
    discordClientId: snowflake(source.discordClientId),
  };
}

export function loadConfig(target: Pick<Window, '__PIXELWAR_CONFIG__'> = window): FrontendConfig {
  return parseConfig(target.__PIXELWAR_CONFIG__);
}
