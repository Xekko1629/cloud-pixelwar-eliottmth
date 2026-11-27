import { useSyncExternalStore } from 'react';
import { AUTH_ERRORS } from './auth/auth';
import { AuthControls, redirectToLogin } from './auth/AuthControls';
import type { AuthServices } from './auth/setup';
import type { FrontendConfig } from './config';
import { Workspace } from './inspect/Workspace';
import type { LiveCanvas, RealtimeState } from './realtime/live';
import { REALTIME_LABELS } from './realtime/setup';
import { DiscordIcon, LogoMark } from './ui/icons';

// Short state of the realtime feed in the header: a dot and one or two words.
const LIVE: Record<RealtimeState['status'], { state: 'ok' | 'pending' | 'error' | 'off'; label: string }> = {
  disabled: { state: 'off', label: 'Hors service' },
  connecting: { state: 'pending', label: 'Connexion' },
  live: { state: 'ok', label: 'En direct' },
  offline: { state: 'pending', label: 'Hors ligne' },
  error: { state: 'error', label: 'Interrompu' },
};

// Shell of the application (WEB-01). The canvas needs a session: its tiles come from the
// API, and every API call must be authenticated (subject §3.4). Without a session it would
// only show the pixels drawn since the page opened, not the up-to-date canvas, so a sign-in
// page stands in its place. Signed in, the canvas fills the window (Workspace).
export function App({ config, services, live }: { config: FrontendConfig; services: AuthServices; live: LiveCanvas }) {
  const realtime = useSyncExternalStore(live.subscribeState, live.getState);
  const auth = useSyncExternalStore(services.auth.subscribe, services.auth.getState);
  const signedIn = auth.status === 'signed-in';
  const feed = LIVE[realtime.status];

  return (
    <main className="app">
      <header className="topbar">
        <div className="brand">
          <LogoMark />
          <h1>Pixel War</h1>
          {config.environment !== 'prd' && <span className="brand__env">{config.environment}</span>}
        </div>
        <div className="topbar__end">
          {signedIn && (
            <span className="live" data-state={feed.state} title={`Temps réel : ${REALTIME_LABELS[realtime.status]}`}>
              {feed.label}
            </span>
          )}
          <AuthControls auth={services.auth} />
        </div>
      </header>
      {signedIn && services.api ? <Workspace api={services.api} live={live} /> : (
        <section className="welcome" aria-labelledby="welcome-title">
          <div className="welcome__card">
            <LogoMark width={48} height={48} />
            <h2 id="welcome-title">Pixel War</h2>
            <p>Une toile géante, dessinée en direct par tout le serveur.</p>
            <button
              type="button"
              className="button button--discord"
              disabled={auth.status === 'pending' || !services.api}
              onClick={() => void redirectToLogin(services.auth)}
            >
              <DiscordIcon />
              {auth.status === 'pending' ? 'Connexion…' : 'Se connecter avec Discord'}
            </button>
            {auth.status === 'signed-out' && auth.error && (
              <p className="welcome__error" role="alert">{AUTH_ERRORS[auth.error]}</p>
            )}
            {!services.api && <p className="welcome__note">API pas encore publiée dans cet environnement.</p>}
          </div>
        </section>
      )}
    </main>
  );
}
