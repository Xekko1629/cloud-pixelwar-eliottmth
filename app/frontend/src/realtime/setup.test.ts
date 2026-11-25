import { describe, expect, it, vi } from 'vitest';
import { parseConfig } from '../config';
import { createLiveCanvas } from './setup';

vi.mock('./firestore', () => ({
  createFirestoreBackend: vi.fn(() => ({ watchConfig: () => () => {}, watchDeltas: () => () => {} })),
}));

const KEY = `AIza${'A'.repeat(35)}`;

describe('createLiveCanvas', () => {
  it('stays disabled without a Firestore configuration', () => {
    expect(createLiveCanvas(parseConfig({})).getState().status).toBe('disabled');
  });

  it('loads the Firestore backend on start when the environment publishes one', async () => {
    const live = createLiveCanvas(parseConfig({ firestoreProjectId: 'cloud-pixelwar-dev', firestoreApiKey: KEY }));
    expect(live.getState().status).toBe('connecting');
    await live.start();
    const { createFirestoreBackend } = await import('./firestore');
    expect(createFirestoreBackend).toHaveBeenCalledWith({ projectId: 'cloud-pixelwar-dev', apiKey: KEY });
  });
});
