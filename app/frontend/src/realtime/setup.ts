import { createFakeTileSource } from '../canvas/tiles';
import type { FrontendConfig } from '../config';
import { LiveCanvas } from './live';

/**
 * Builds the realtime canvas once per page load. The Firebase SDK is only downloaded when
 * the environment publishes a Firestore configuration. The base tiles stay fake until
 * tile-reader is wired (WEB-03b).
 */
export function createLiveCanvas(config: FrontendConfig): LiveCanvas {
  const firestore = config.firestore;
  const load = firestore
    ? () => import('./firestore').then((module) => module.createFirestoreBackend(firestore))
    : null;
  return new LiveCanvas(createFakeTileSource(), load);
}

export const REALTIME_LABELS = {
  disabled: 'pas encore configuré',
  connecting: 'connexion…',
  live: 'connecté',
  error: 'interrompu',
} as const;
