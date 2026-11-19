import { describe, expect, it } from 'vitest';
import { loadConfig, parseConfig } from './config';

describe('parseConfig', () => {
  it('keeps a valid deployed configuration', () => {
    expect(parseConfig({
      environment: 'prd',
      gatewayUrl: 'https://pixelwar-abc.ew.gateway.dev/',
      realtimeUrl: 'https://realtime-xyz-ew.a.run.app',
      discordClientId: '1234567890123456789',
    })).toEqual({
      environment: 'prd',
      gatewayUrl: 'https://pixelwar-abc.ew.gateway.dev',
      realtimeUrl: 'https://realtime-xyz-ew.a.run.app',
      discordClientId: '1234567890123456789',
    });
  });

  it('treats empty values as not yet deployed', () => {
    expect(parseConfig({ environment: 'dev', gatewayUrl: '', realtimeUrl: '', discordClientId: '' })).toEqual({
      environment: 'dev', gatewayUrl: null, realtimeUrl: null, discordClientId: null,
    });
  });

  it('refuses plain http outside a local development server', () => {
    expect(parseConfig({ gatewayUrl: 'http://pixelwar.example.com' }).gatewayUrl).toBeNull();
    expect(parseConfig({ gatewayUrl: 'http://localhost:8080/' }).gatewayUrl).toBe('http://localhost:8080');
    expect(parseConfig({ gatewayUrl: 'javascript:alert(1)' }).gatewayUrl).toBeNull();
    expect(parseConfig({ gatewayUrl: 'not a url' }).gatewayUrl).toBeNull();
  });

  it('refuses a malformed Discord client id', () => {
    expect(parseConfig({ discordClientId: '0123' }).discordClientId).toBeNull();
    expect(parseConfig({ discordClientId: 123456 }).discordClientId).toBeNull();
  });

  it('falls back to a local configuration without /config.js', () => {
    expect(parseConfig(undefined)).toEqual({
      environment: 'local', gatewayUrl: null, realtimeUrl: null, discordClientId: null,
    });
    expect(parseConfig({ environment: 'staging' }).environment).toBe('local');
  });
});

describe('loadConfig', () => {
  it('reads the object published by /config.js on window', () => {
    window.__PIXELWAR_CONFIG__ = { environment: 'dev', gatewayUrl: 'https://gw.example.dev' };
    try {
      expect(loadConfig()).toMatchObject({ environment: 'dev', gatewayUrl: 'https://gw.example.dev' });
    } finally {
      delete window.__PIXELWAR_CONFIG__;
    }
  });
});
