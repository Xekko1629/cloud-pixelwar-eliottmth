import { expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  construct: vi.fn(), create: vi.fn(), createGroup: vi.fn(), commit: vi.fn(),
  process: vi.fn().mockResolvedValue({ type: 'pixel-processed' }), processGroup: vi.fn(),
}));
vi.mock('@google-cloud/firestore', () => ({ Firestore: class {
  constructor(settings: unknown) { mocks.construct(settings); }
} }));
vi.mock('@pixelwar/shared/drawing', async (original) => {
  const actual = await original<typeof import('@pixelwar/shared/drawing')>();
  return {
    createDrawProcessor: (...args: unknown[]) => { mocks.create(...args); return mocks.process; },
    createGroupDrawProcessor: (...args: unknown[]) => { mocks.createGroup(...args); return mocks.processGroup; },
    createGroupCommit: (...args: Parameters<typeof actual.createGroupCommit>) => { mocks.commit(...args); return actual.createGroupCommit(...args); },
  };
});
import { MAX_DRAW_GROUP, createLazyDrawProcessor } from './processor';

const command = { event_id: '11111111-1111-4111-8111-111111111111', occurred_at: '2026-11-19T10:00:00.000Z', source: 'web' as const,
  author: { uid: '123', name: 'User' }, pixels: [{ x: 0, y: 0, color: 1 }] };

it('initializes Firestore on first use only and groups through the DATA-02 processors', async () => {
  const process = createLazyDrawProcessor('demo-pixelwar-test');
  expect(mocks.construct).not.toHaveBeenCalled();
  expect(await process(command)).toEqual({ type: 'pixel-processed' }); await process(command);
  expect(mocks.construct).toHaveBeenCalledExactlyOnceWith({ projectId: 'demo-pixelwar-test' });
  expect(mocks.create).toHaveBeenCalledTimes(1); expect(mocks.createGroup).toHaveBeenCalledTimes(1);
  expect(mocks.commit.mock.calls[0][2]).toMatchObject({ max_group: MAX_DRAW_GROUP });
  expect(mocks.process).toHaveBeenCalledTimes(2); // Idle instance: each command alone.
});

it('logs one line per group and none for a command processed alone', async () => {
  const lines: string[] = [];
  let release!: () => void;
  mocks.process.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve({ type: 'pixel-processed' }); }));
  mocks.processGroup.mockResolvedValueOnce([{ type: 'pixel-processed' }, { type: 'pixel-processed' }]);
  const process = createLazyDrawProcessor('demo-pixelwar-test', (line) => lines.push(line));
  const first = process(command);
  await vi.waitFor(() => expect(release).toBeDefined());
  const grouped = [process(command), process(command)];
  release();
  await Promise.all([first, ...grouped]);
  expect(lines.map((line) => JSON.parse(line))).toEqual([
    { severity: 'INFO', function: 'draw-worker', event_type: 'draw.group.committed', group_size: 2 },
  ]);
});
