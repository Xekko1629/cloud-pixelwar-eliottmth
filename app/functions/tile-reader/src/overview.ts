import { Storage } from '@google-cloud/storage';
import { overviewObjectName, type OverviewLevel } from '@pixelwar/shared/overview';

/** Short enough to limit a leaked link, long enough for the browser to reuse it (ADR-0013). */
export const SIGNED_URL_LIFETIME_MS = 15 * 60_000;

export type SignOverview = (version: number, cell: { level: OverviewLevel; cx: number; cy: number }) =>
  Promise<{ url: string; expires_at: string }>;
type SignUrl = (bucket: string, object: string, expires: number) => Promise<string>;

/**
 * V4 read URL of one far-view image. Without a key file, the library signs through the IAM
 * signBlob API with the runtime identity: it needs serviceAccountTokenCreator on itself only.
 */
export function createOverviewSigner(projectId: string, bucket: string, now: () => number = Date.now, sign?: SignUrl): SignOverview {
  let storage: Storage | undefined;
  const signUrl: SignUrl = sign ?? (async (name, object, expires) => {
    storage ??= new Storage({ projectId });
    const [url] = await storage.bucket(name).file(object).getSignedUrl({ version: 'v4', action: 'read', expires });
    return url;
  });
  return async (version, { level, cx, cy }) => {
    const expires = now() + SIGNED_URL_LIFETIME_MS;
    const url = await signUrl(bucket, overviewObjectName(version, level, cx, cy), expires);
    return { url, expires_at: new Date(expires).toISOString() };
  };
}
