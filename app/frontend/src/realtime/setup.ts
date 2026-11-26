import { decodeRegionTiles } from '@pixelwar/shared/grid';
import type { ApiClient } from '../api/client';
import type { AuthServices } from '../auth/setup';
import type { RegionFetcher, TileStatus } from '../canvas/region-tiles';
import type { FrontendConfig } from '../config';
import { LiveCanvas } from './live';

/** GET /api/regions/{rx}/{ry}/tiles through the session client (docs/tile-reader.md). */
export function createRegionFetcher(api: ApiClient): RegionFetcher {
  return async (rx, ry) => {
    // no-cache: the browser keeps the answer and revalidates it with its ETag, so an
    // unchanged region costs a 304. If-None-Match is not set here: it is not a CORS-safe
    // header, and tile-reader only allows Authorization in its preflight.
    const response = await api.request(`/api/regions/${rx}/${ry}/tiles`, {
      cache: 'no-cache',
      headers: { Accept: 'application/octet-stream' },
    });
    // The browser turns a 304 into the cached 200; fetch has already removed the gzip.
    if (response.status !== 200) throw new Error(`Unexpected status ${response.status}`);
    return decodeRegionTiles(new Uint8Array(await response.arrayBuffer()), rx, ry);
  };
}

/**
 * Builds the canvas data once per page load. The Firebase SDK is only downloaded when the
 * environment publishes a Firestore configuration. The tiles of tile-reader need a
 * session: they load on sign-in and are dropped on sign-out (App hides the canvas then).
 */
export function createLiveCanvas(config: FrontendConfig, services: AuthServices): LiveCanvas {
  const firestore = config.firestore;
  const load = firestore
    ? () => import('./firestore').then((module) => module.createFirestoreBackend(firestore))
    : null;
  const live = new LiveCanvas(load);
  const api = services.api;
  if (api) {
    const fetcher = createRegionFetcher(api);
    const sync = () => live.setTileFetcher(services.auth.getState().status === 'signed-in' ? fetcher : null);
    services.auth.subscribe(sync);
    sync();
  }
  return live;
}

export const REALTIME_LABELS = {
  disabled: 'pas encore configuré',
  connecting: 'connexion…',
  live: 'connecté',
  error: 'interrompu',
} as const;

export const TILE_LABELS: Record<TileStatus, string> = {
  'signed-out': 'connexion requise',
  loading: 'chargement…',
  ready: 'à jour',
  far: 'zoome pour charger les pixels',
  error: 'chargement impossible, nouvel essai dans 10 s',
};
