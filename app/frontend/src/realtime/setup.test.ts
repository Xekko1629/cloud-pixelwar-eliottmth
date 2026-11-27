import { describe, expect, it, vi } from 'vitest';
import { encodeRegionTiles } from '@pixelwar/shared/grid';
import { ApiClient } from '../api/client';
import { createAuthServices } from '../auth/setup';
import { SESSION_KEY, SessionStore } from '../auth/session';
import { TOKEN, USER, memoryStorage } from '../auth/testing';
import { parseConfig } from '../config';
import { createLiveCanvas, createRegionFetcher } from './setup';

vi.mock('./firestore', () => ({
  createFirestoreBackend: vi.fn(() => ({ watchConfig: () => () => {}, watchDeltas: () => () => {} })),
}));

const KEY = `AIza${'A'.repeat(35)}`;

describe('createLiveCanvas', () => {
  it('stays disabled without a Firestore configuration', () => {
    expect(createLiveCanvas(parseConfig({}), createAuthServices(parseConfig({}))).getState().status).toBe('disabled');
  });

  it('loads the Firestore backend on start when the environment publishes one', async () => {
    const config = parseConfig({ firestoreProjectId: 'cloud-pixelwar-dev', firestoreApiKey: KEY });
    const live = createLiveCanvas(config, createAuthServices(config));
    expect(live.getState().status).toBe('connecting');
    await live.start();
    const { createFirestoreBackend } = await import('./firestore');
    expect(createFirestoreBackend).toHaveBeenCalledWith({ projectId: 'cloud-pixelwar-dev', apiKey: KEY });
  });
});

const session = (expiresAt = Date.now() + 15 * 60_000) => JSON.stringify({ token: TOKEN, expiresAt, user: USER });

describe('createRegionFetcher', () => {
  function client(response: Response) {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => response);
    const sessions = new SessionStore(memoryStorage({ [SESSION_KEY]: session() }));
    return { fetch, fetcher: createRegionFetcher(new ApiClient({ baseUrl: 'https://gw.example.dev', sessions, fetch })) };
  }

  it('reads a region with the session, revalidated by the browser cache', async () => {
    const tiles = [{ tx: -16, ty: 0, colors: new Uint8Array(64 * 64).fill(7) }];
    const { fetch, fetcher } = client(new Response(encodeRegionTiles(3, -1, 0, tiles).buffer as ArrayBuffer, { status: 200, headers: { ETag: 'W/"abc"' } }));
    const answer = await fetcher(-1, 0);
    expect(answer.canvas_version).toBe(3);
    expect(answer.tiles[0]?.colors[0]).toBe(7);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('https://gw.example.dev/api/regions/-1/0/tiles');
    expect(init?.headers).toMatchObject({ Authorization: `Bearer ${TOKEN}` });
    // Only CORS-safe headers besides Authorization, the one the preflight allows.
    expect(Object.keys(init?.headers ?? {}).sort()).toEqual(['Accept', 'Authorization']);
    expect(init?.cache).toBe('no-cache');
  });

  it('refuses a 304 the browser did not resolve from its cache', async () => {
    const { fetcher } = client(new Response(null, { status: 304 }));
    await expect(fetcher(0, 0)).rejects.toThrow('304');
  });

  it('refuses a malformed region', async () => {
    const { fetcher } = client(new Response(new Uint8Array([9, 9]), { status: 200 }));
    await expect(fetcher(0, 0)).rejects.toThrow();
  });
});

describe('createLiveCanvas and the session', () => {
  it('loads the tiles only while signed in', () => {
    const config = parseConfig({ gatewayUrl: 'https://gw.example.dev' });
    const storage = memoryStorage({ [SESSION_KEY]: session() });
    const services = createAuthServices(config, { sessionStorage: storage as unknown as Storage });
    const live = createLiveCanvas(config, services);
    // No viewport yet: nothing to load, but the session is there.
    expect(live.getState().tiles).toBe('ready');
    services.auth.signOut();
    expect(live.getState().tiles).toBe('signed-out');
  });
});
