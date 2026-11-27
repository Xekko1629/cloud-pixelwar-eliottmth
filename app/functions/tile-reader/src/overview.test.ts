import { expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ storage: vi.fn(), getSignedUrl: vi.fn(async () => ['https://signed.example.test/x']), file: vi.fn() }));
vi.mock('@google-cloud/storage', () => ({ Storage: class {
  constructor(settings: unknown) { mocks.storage(settings); }
  bucket(name: string) { return { file: (object: string) => { mocks.file(name, object); return { getSignedUrl: mocks.getSignedUrl }; } }; }
} }));
import { SIGNED_URL_LIFETIME_MS, createOverviewSigner } from './overview';

const now = Date.parse('2026-11-26T12:00:00.000Z');

it('signs a 15-minute V4 read URL of the versioned object, with one Storage client', async () => {
  const sign = createOverviewSigner('demo-pixelwar-test', 'demo-pixelwar-test-overview', () => now);
  expect(mocks.storage).not.toHaveBeenCalled();
  expect(await sign(3, { level: 1, cx: -2, cy: 5 })).toEqual({
    url: 'https://signed.example.test/x', expires_at: new Date(now + SIGNED_URL_LIFETIME_MS).toISOString(),
  });
  await sign(3, { level: 3, cx: 0, cy: 0 });
  expect(mocks.storage).toHaveBeenCalledExactlyOnceWith({ projectId: 'demo-pixelwar-test' });
  expect(mocks.file.mock.calls).toEqual([['demo-pixelwar-test-overview', 'v3/1/-2_5.png'], ['demo-pixelwar-test-overview', 'v3/3/0_0.png']]);
  expect(mocks.getSignedUrl).toHaveBeenCalledWith({ version: 'v4', action: 'read', expires: now + SIGNED_URL_LIFETIME_MS });
});

it('accepts an injected signer and refuses an invalid cell before signing', async () => {
  const signUrl = vi.fn(async () => 'https://signed.example.test/y');
  const sign = createOverviewSigner('p', 'b', () => now, signUrl);
  await sign(1, { level: 2, cx: 1, cy: 1 });
  expect(signUrl).toHaveBeenCalledWith('b', 'v1/2/1_1.png', now + SIGNED_URL_LIFETIME_MS);
  await expect(sign(1, { level: 1, cx: 0.5, cy: 0 })).rejects.toThrow();
});
