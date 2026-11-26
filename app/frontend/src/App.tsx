import { useSyncExternalStore } from 'react';
import { AuthControls } from './auth/AuthControls';
import type { AuthServices } from './auth/setup';
import { PixelCanvas } from './canvas/PixelCanvas';
import type { FrontendConfig } from './config';
import type { LiveCanvas } from './realtime/live';
import { REALTIME_LABELS, TILE_LABELS } from './realtime/setup';

// Shell of the application (WEB-01). The canvas shows the tiles of tile-reader once signed
// in (WEB-03b), with the realtime deltas painted over them (DRAW-03a); the Discord login
// (WEB-02b) sits in the header.
export function App({ config, services, live }: { config: FrontendConfig; services: AuthServices; live: LiveCanvas }) {
  const realtime = useSyncExternalStore(live.subscribeState, live.getState);

  return (
    <main className="app">
      <header className="app__header">
        <h1>Pixel War</h1>
        <span className="app__environment" data-environment={config.environment}>{config.environment}</span>
        <AuthControls auth={services.auth} />
      </header>
      <section className="app__status" aria-label="État des services">
        <p>API : {config.gatewayUrl ? 'disponible' : 'pas encore publiée'}</p>
        <p>Toile : {TILE_LABELS[realtime.tiles]}</p>
        <p>Temps réel : {REALTIME_LABELS[realtime.status]}</p>
        {realtime.config?.paused && <p className="app__paused" role="status">Toile en pause</p>}
      </section>
      <PixelCanvas live={live} />
    </main>
  );
}
