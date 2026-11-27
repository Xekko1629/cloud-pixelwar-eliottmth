import { expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ firestore: vi.fn(), storage: vi.fn(), cycle: vi.fn(async () => ({ mode: 'full' })) }));
vi.mock('@google-cloud/firestore', async (original) => ({
  ...await original<object>(), Firestore: class { constructor(settings: unknown) { mocks.firestore(settings); } },
}));
vi.mock('@google-cloud/storage', () => ({ Storage: class { constructor(settings: unknown) { mocks.storage(settings); } bucket() { return {}; } } }));
vi.mock('./cycle', async (original) => ({ ...await original<object>(), runOverviewCycle: mocks.cycle }));
import { createLazyCycle } from './index';

it('creates the Firestore and Storage clients once, on the first tick', async () => {
  const cycle = createLazyCycle('demo-pixelwar-test', 'demo-pixelwar-test-overview');
  expect(mocks.firestore).not.toHaveBeenCalled();
  await cycle(); await cycle();
  expect(mocks.firestore).toHaveBeenCalledExactlyOnceWith({ projectId: 'demo-pixelwar-test' });
  expect(mocks.storage).toHaveBeenCalledExactlyOnceWith({ projectId: 'demo-pixelwar-test' });
  expect(mocks.cycle).toHaveBeenCalledTimes(2);
});
