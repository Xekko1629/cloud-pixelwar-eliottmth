import { describe, expect, it } from 'vitest';
import { parseConfig } from '../config';
import { createAuthServices } from './setup';

describe('createAuthServices', () => {
  it('builds an HTTP client when the gateway is published', () => {
    const { api, auth } = createAuthServices(parseConfig({ gatewayUrl: 'https://gw.example.dev' }));
    expect(api).not.toBeNull();
    expect(auth.getState()).toEqual({ status: 'signed-out', error: null });
  });

  it('has no HTTP client before the gateway exists, and survives a blocked storage', () => {
    const blocked = { get sessionStorage(): Storage { throw new Error('SecurityError'); } };
    const { api, auth } = createAuthServices(parseConfig({}), blocked);
    expect(api).toBeNull();
    expect(auth.getState().status).toBe('signed-out');
  });
});
