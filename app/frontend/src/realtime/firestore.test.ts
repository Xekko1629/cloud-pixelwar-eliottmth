import { beforeEach, describe, expect, it, vi } from 'vitest';

// The SDK is replaced: these tests check which listeners are opened, with which filters.
const sdk = vi.hoisted(() => ({
  initializeApp: vi.fn(() => ({ name: 'app' })),
  getFirestore: vi.fn(() => ({ name: 'db' })),
  doc: vi.fn((...path: unknown[]) => ({ path: path.slice(1).join('/') })),
  collection: vi.fn((...path: unknown[]) => ({ path: path.slice(1).join('/') })),
  where: vi.fn((field: string, op: string, value: unknown) => ({ field, op, value })),
  query: vi.fn((ref: unknown, ...filters: unknown[]) => ({ ref, filters })),
  onSnapshot: vi.fn(),
  Timestamp: { fromMillis: vi.fn((ms: number) => ({ ms })) },
}));
vi.mock('firebase/app', () => ({ initializeApp: sdk.initializeApp }));
vi.mock('firebase/firestore', () => sdk);

const { createFirestoreBackend } = await import('./firestore');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('createFirestoreBackend', () => {
  it('initialises a named app with the public configuration only', () => {
    createFirestoreBackend({ projectId: 'cloud-pixelwar-dev', apiKey: 'key' });
    expect(sdk.initializeApp).toHaveBeenCalledWith({ projectId: 'cloud-pixelwar-dev', apiKey: 'key' }, 'pixelwar-realtime');
  });

  it('listens to config/global and passes its data, or null when missing', () => {
    const unsubscribe = vi.fn();
    sdk.onSnapshot.mockReturnValue(unsubscribe);
    const next = vi.fn();
    const error = vi.fn();
    const stop = createFirestoreBackend({ projectId: 'p', apiKey: 'k' }).watchConfig(next, error);
    expect(stop).toBe(unsubscribe);
    const [ref, options, onNext, onError] = sdk.onSnapshot.mock.calls[0]! as unknown as [unknown, unknown, (s: unknown) => void, unknown];
    expect(ref).toEqual({ path: 'config/global' });
    // Metadata changes too: a snapshot from the cache tells that the connection is lost.
    expect(options).toEqual({ includeMetadataChanges: true });
    expect(onError).toBe(error);
    onNext({ data: () => ({ canvas_version: 1 }), metadata: { fromCache: false } });
    onNext({ data: () => undefined, metadata: { fromCache: false } });
    onNext({ data: () => ({ canvas_version: 1 }), metadata: { fromCache: true } });
    expect(next.mock.calls).toEqual([[{ canvas_version: 1 }, false], [null, false], [{ canvas_version: 1 }, true]]);
  });

  it('queries the deltas of the visible regions with the indexed filters, added documents only', () => {
    const added = vi.fn();
    createFirestoreBackend({ projectId: 'p', apiKey: 'k' })
      .watchDeltas({ canvasVersion: 3, regions: ['0_0', '1_0'], since: 1000 }, added, vi.fn());
    const [q, onNext] = sdk.onSnapshot.mock.calls[0]! as unknown as [unknown, (s: unknown) => void];
    expect(q).toEqual({
      ref: { path: 'deltas' },
      filters: [
        { field: 'canvas_version', op: '==', value: 3 },
        { field: 'region', op: 'in', value: ['0_0', '1_0'] },
        { field: 'created_at', op: '>', value: { ms: 1000 } },
      ],
    });
    onNext({
      metadata: { fromCache: false },
      docChanges: () => [
        { type: 'added', doc: { data: () => ({ id: 1 }) } },
        { type: 'removed', doc: { data: () => ({ id: 2 }) } },
      ],
    });
    expect(added).toHaveBeenCalledWith([{ id: 1 }], false);
  });

  it('drops the region filter in the far view', () => {
    createFirestoreBackend({ projectId: 'p', apiKey: 'k' })
      .watchDeltas({ canvasVersion: 1, regions: null, since: 0 }, vi.fn(), vi.fn());
    const [q] = sdk.onSnapshot.mock.calls[0]! as unknown as [{ filters: Array<{ field: string }> }];
    expect(q.filters.map((filter) => filter.field)).toEqual(['canvas_version', 'created_at']);
  });
});
