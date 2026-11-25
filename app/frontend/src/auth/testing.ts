import type { KeyValueStorage } from './session';

// Test helpers shared by the auth and api tests (not bundled: only test files import it).
export const TOKEN = 'test-header.test-payload.test-signature';
export const USER = { id: '123456789012345678', name: 'pixel_fan' };

export function memoryStorage(entries: Record<string, string> = {}): KeyValueStorage & { entries: Map<string, string> } {
  const map = new Map(Object.entries(entries));
  return {
    entries: map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => { map.set(key, value); },
    removeItem: (key) => { map.delete(key); },
  };
}

export function sessionBody(expiresAt: number, token = TOKEN) {
  return { token, expires_at: new Date(expiresAt).toISOString(), user: USER };
}

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
