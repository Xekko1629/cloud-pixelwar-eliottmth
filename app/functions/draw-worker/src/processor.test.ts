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
  // ADR-0017: both processors skip the quota of web pixels, reserved upstream.
  expect(mocks.create.mock.calls[0][1]).toEqual({ reserved_sources: ['web'] });
  expect(mocks.createGroup.mock.calls[0][1]).toEqual({ reserved_sources: ['web'] });
  expect(mocks.commit.mock.calls[0][2]).toMatchObject({ max_group: MAX_DRAW_GROUP });
  expect(mocks.process).toHaveBeenCalledTimes(2); // Idle instance: each command alone.
});

it('logs one line per group, with its wait and Firestore timing, and none for a command processed alone', async () => {
  const lines: string[] = [];
  let release!: () => void;
  const timing = { attempts: 3, read_processed_ms: 40, read_people_ms: 400, read_tiles_ms: 60, transaction_ms: 1700 };
  mocks.process.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve({ type: 'pixel-processed' }); }));
  mocks.processGroup.mockImplementationOnce(async () => {
    mocks.createGroup.mock.calls.at(-1)![2](timing); // The real group processor reports before it resolves.
    return [{ type: 'pixel-processed' }, { type: 'pixel-processed' }];
  });
  const process = createLazyDrawProcessor('demo-pixelwar-test', (line) => lines.push(line));
  const first = process(command);
  await vi.waitFor(() => expect(release).toBeDefined());
  const grouped = [process(command), process(command)];
  release();
  await Promise.all([first, ...grouped]);
  expect(lines.map((line) => JSON.parse(line))).toEqual([
    { severity: 'INFO', function: 'draw-worker', event_type: 'draw.group.committed', group_size: 2, wait_ms: expect.any(Number), ...timing },
  ]);
});

it('logs a contended group as a warning, with its timing', async () => {
  const lines: string[] = [];
  let release!: () => void;
  const timing = { attempts: 10, read_processed_ms: 20, read_people_ms: 10, read_tiles_ms: 700, transaction_ms: 9000 };
  mocks.process.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve({ type: 'pixel-processed' }); }));
  mocks.processGroup.mockImplementationOnce(async () => {
    mocks.createGroup.mock.calls.at(-1)![2](timing);
    throw Object.assign(new Error('ABORTED'), { code: 10 });
  });
  const process = createLazyDrawProcessor('demo-pixelwar-test', (line) => lines.push(line));
  const first = process(command);
  await vi.waitFor(() => expect(release).toBeDefined());
  const grouped = [process(command), process(command)].map((p) => p.catch(() => 'refused'));
  release();
  expect(await Promise.all(grouped)).toEqual(['refused', 'refused']);
  await first;
  expect(lines.map((line) => JSON.parse(line))).toEqual([
    { severity: 'WARNING', function: 'draw-worker', event_type: 'draw.group.contention', group_size: 2, wait_ms: expect.any(Number), ...timing },
  ]);
});

it('logs a fallback as a warning, without the timing of an earlier group', async () => {
  const lines: string[] = [];
  let release!: () => void;
  mocks.process.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve({ type: 'pixel-processed' }); }));
  mocks.processGroup.mockRejectedValueOnce(new Error('aborted'));
  const process = createLazyDrawProcessor('demo-pixelwar-test', (line) => lines.push(line));
  const first = process(command);
  await vi.waitFor(() => expect(release).toBeDefined());
  const grouped = [process(command), process(command)];
  release();
  await Promise.all([first, ...grouped]);
  expect(lines.map((line) => JSON.parse(line))).toEqual([
    { severity: 'WARNING', function: 'draw-worker', event_type: 'draw.group.fallback', group_size: 2, wait_ms: expect.any(Number) },
  ]);
});
