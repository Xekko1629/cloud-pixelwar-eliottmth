import type { HttpFunction } from '@google-cloud/functions-framework';
import { afterEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ construct: vi.fn(), reserve: vi.fn() }));
vi.mock('@google-cloud/firestore', () => ({ Firestore: class { constructor(settings: unknown) { mocks.construct(settings); } } }));
vi.mock('@pixelwar/shared/drawing', async (original) => ({
  ...await original<typeof import('@pixelwar/shared/drawing')>(),
  createQuotaReservation: () => mocks.reserve,
}));

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

it('opens one Firestore client on the first request only, and logs to stdout', async () => {
  vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'demo-pixelwar-test');
  const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  mocks.reserve.mockResolvedValue({ granted: 1, refused: 0, retry_after_seconds: null, limit_per_minute: 20, remaining_pixels: 19, reset_at: '2026-11-27T15:31:00.000Z' });
  const { handleQuotaReserver } = await import('./index');
  expect(mocks.construct).not.toHaveBeenCalled();
  const body = Buffer.from(JSON.stringify({ reservation_id: 'r-1', uid: '123456789012345678', pixel_count: 1 }));
  for (let i = 0; i < 2; i += 1) {
    const res = { status: vi.fn(), json: vi.fn(), set: vi.fn() };
    res.status.mockReturnValue(res); res.set.mockReturnValue(res);
    await handleQuotaReserver({ path: '/', method: 'POST', rawBody: body } as unknown as Parameters<HttpFunction>[0], res as unknown as Parameters<HttpFunction>[1]);
    expect(res.status).toHaveBeenCalledWith(200);
  }
  expect(mocks.construct).toHaveBeenCalledExactlyOnceWith({ projectId: 'demo-pixelwar-test' });
  expect(String(stdout.mock.calls[0]![0])).toContain('"event_type":"quota.reserved"');
  stdout.mockRestore();
});
