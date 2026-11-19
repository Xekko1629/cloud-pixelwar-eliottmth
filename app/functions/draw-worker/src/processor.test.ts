import { expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ construct: vi.fn(), create: vi.fn(), process: vi.fn().mockResolvedValue({ type: 'pixel-processed' }) }));
vi.mock('@google-cloud/firestore', () => ({ Firestore: class {
  constructor(settings: unknown) { mocks.construct(settings); }
} }));
vi.mock('@pixelwar/shared/drawing', () => ({ createDrawProcessor: (...args: unknown[]) => { mocks.create(...args); return mocks.process; } }));
import { createLazyDrawProcessor } from './processor';

it('initializes Firestore on first use only and reuses the DATA-02 processor', async () => {
  const process = createLazyDrawProcessor('demo-pixelwar-test');
  expect(mocks.construct).not.toHaveBeenCalled();
  const command = { event_id: '11111111-1111-4111-8111-111111111111', occurred_at: '2026-11-19T10:00:00.000Z', source: 'web' as const,
    author: { uid: '123', name: 'User' }, pixels: [{ x: 0, y: 0, color: 1 }] };
  expect(await process(command)).toEqual({ type: 'pixel-processed' }); await process(command);
  expect(mocks.construct).toHaveBeenCalledExactlyOnceWith({ projectId: 'demo-pixelwar-test' });
  expect(mocks.create).toHaveBeenCalledTimes(1); expect(mocks.process).toHaveBeenCalledTimes(2);
});
