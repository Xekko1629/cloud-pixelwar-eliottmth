import { describe, expect, it, vi } from 'vitest';
import { ApiClient } from '../api/client';
import { SESSION_KEY, SessionStore } from '../auth/session';
import { TOKEN, USER, jsonResponse, memoryStorage } from '../auth/testing';
import { overviewLoader, readPreviewSetting, writePreviewSetting } from './Workspace';

describe('preview setting', () => {
  it('is on unless turned off, and remembers the choice', () => {
    const values = new Map<string, string>();
    const storage = () => ({ getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value) });
    expect(readPreviewSetting(storage)).toBe(true);
    writePreviewSetting(false, storage);
    expect(readPreviewSetting(storage)).toBe(false);
    writePreviewSetting(true, storage);
    expect(readPreviewSetting(storage)).toBe(true);
  });

  it('stays on when the storage is blocked', () => {
    const blocked = () => { throw new Error('SecurityError'); };
    expect(readPreviewSetting(blocked)).toBe(true);
    expect(() => writePreviewSetting(false, blocked)).not.toThrow();
  });
});

describe('overviewLoader', () => {
  function setup() {
    const body = { canvas_version: 1, level: 1, cx: 0, cy: -1, url: 'https://storage.googleapis.com/b/v1/1/0_-1.png?sig', expires_at: '2026-11-26T12:15:00.000Z' };
    const fetch = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(200, body));
    const session = JSON.stringify({ token: TOKEN, expiresAt: Date.now() + 15 * 60_000, user: USER });
    const api = new ApiClient({ baseUrl: 'https://gw.example.dev', sessions: new SessionStore(memoryStorage({ [SESSION_KEY]: session })), fetch });
    const element = { src: '', decoding: '', onload: null as null | (() => void), onerror: null as null | (() => void) };
    const load = overviewLoader(api, () => element as unknown as HTMLImageElement);
    return { load, element };
  }

  it('loads the image behind the signed URL', async () => {
    const { load, element } = setup();
    const result = load(1, 0, -1);
    await vi.waitFor(() => expect(element.src).toBe('https://storage.googleapis.com/b/v1/1/0_-1.png?sig'));
    element.onload!();
    expect(await result).toBe(element);
  });

  it('gives null for an empty area (no image, 404)', async () => {
    const { load, element } = setup();
    const result = load(1, 0, -1);
    await vi.waitFor(() => expect(element.onerror).not.toBeNull());
    element.onerror!();
    expect(await result).toBeNull();
  });
});
