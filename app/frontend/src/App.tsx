import { useSyncExternalStore } from 'react';
import { AuthControls, redirectToLogin } from './auth/AuthControls';
import type { AuthServices } from './auth/setup';
import { PixelCanvas } from './canvas/PixelCanvas';
import type { FrontendConfig } from './config';
import type { LiveCanvas } from './realtime/live';
import { REALTIME_LABELS, TILE_LABELS } from './realtime/setup';

// Shell of the application (WEB-01). The Discord login (WEB-02b) sits in the header. The
// canvas needs a session: its tiles come from the API, and every API call must be
// authenticated (subject §3.4). Without a session it would only show the pixels drawn since
// the page opened, not the up-to-date canvas, so it stays hidden. Signed in, it shows the
// tiles of tile-reader (WEB-03b) with the realtime deltas over them (DRAW-03a).
export function App({ config, services, live }: { config: FrontendConfig; services: AuthServices; live: LiveCanvas }) {
  const realtime = useSyncExternalStore(live.subscribeState, live.getState);
  const auth = useSyncExternalStore(services.auth.subscribe, services.auth.getState);
  const signedIn = auth.status === 'signed-in';

  return (
    <main className="app">
      <header className="app__header">
        <h1>Pixel War</h1>
        <span className="app__environment" data-environment={config.environment}>{config.environment}</span>
        <AuthControls auth={services.auth} />
      </header>
      <section className="app__status" aria-label="État des services">
        <p>API : {config.gatewayUrl ? 'disponible' : 'pas encore publiée'}</p>
        {signedIn && <p>Toile : {TILE_LABELS[realtime.tiles]}</p>}
        <p>Temps réel : {REALTIME_LABELS[realtime.status]}</p>
        {realtime.config?.paused && <p className="app__paused" role="status">Toile en pause</p>}
      </section>
      {signedIn ? <PixelCanvas live={live} /> : (
        <section className="app__locked" aria-label="Connexion requise">
          <p>Connecte-toi avec Discord pour voir la toile et dessiner.</p>
          <button
            type="button"
            className="auth__button"
            disabled={auth.status === 'pending' || !services.api}
            onClick={() => void redirectToLogin(services.auth)}
          >
            {auth.status === 'pending' ? 'Connexion…' : 'Se connecter avec Discord'}
          </button>
        </section>
      )}
    </main>
  );
}
