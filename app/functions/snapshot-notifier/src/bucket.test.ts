import { expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ storage: vi.fn(), download: vi.fn(), getSignedUrl: vi.fn(), file: vi.fn() }));
vi.mock('@google-cloud/storage', () => ({ Storage: class {
  constructor(settings: unknown) { mocks.storage(settings); }
  bucket(name: string) { return { file: (object: string) => { mocks.file(name, object); return { download: mocks.download, getSignedUrl: mocks.getSignedUrl }; } }; }
} }));
import { InvalidSnapshotRequest } from '@pixelwar/shared/snapshot';
import { createBucketAccess } from './index';

const eventId = '0f8c1f5e-2d3a-8b4c-9d5e-6f7a8b9c0d1e';

it('reads the request object of an event and signs a V4 read URL, with one Storage client', async () => {
  const access = createBucketAccess('demo-pixelwar-test', 'demo-pixelwar-test-snapshots');
  mocks.download.mockResolvedValueOnce([Buffer.from('{"a":1}')]);
  expect(await access.readRequest(eventId)).toEqual({ a: 1 });
  mocks.getSignedUrl.mockResolvedValueOnce(['https://signed.example.test/x']);
  expect(await access.sign('snapshots/x.png', 1_000)).toBe('https://signed.example.test/x');
  expect(mocks.storage).toHaveBeenCalledExactlyOnceWith({ projectId: 'demo-pixelwar-test' });
  expect(mocks.file.mock.calls).toEqual([['demo-pixelwar-test-snapshots', `requests/${eventId}.json`], ['demo-pixelwar-test-snapshots', 'snapshots/x.png']]);
  expect(mocks.getSignedUrl).toHaveBeenCalledWith({ version: 'v4', action: 'read', expires: 1_000 });
});

it('returns null for a missing request, refuses unreadable JSON and propagates other failures', async () => {
  const access = createBucketAccess('p', 'b');
  mocks.download.mockRejectedValueOnce(Object.assign(new Error('No such object'), { code: 404 }));
  expect(await access.readRequest(eventId)).toBeNull();
  mocks.download.mockResolvedValueOnce([Buffer.from('{not json')]);
  await expect(access.readRequest(eventId)).rejects.toBeInstanceOf(InvalidSnapshotRequest);
  mocks.download.mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 403 }));
  await expect(access.readRequest(eventId)).rejects.toThrow('denied');
});
