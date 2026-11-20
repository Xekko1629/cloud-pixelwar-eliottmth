import type { FrontendConfig } from './config';

// Shell of the application (WEB-01). The canvas (WEB-03a) and the Discord login (WEB-02b)
// mount here; until then the page only states what the environment exposes.
export function App({ config }: { config: FrontendConfig }) {
  return (
    <main className="app">
      <header className="app__header">
        <h1>Pixel War</h1>
        <span className="app__environment" data-environment={config.environment}>{config.environment}</span>
      </header>
      <section className="app__status" aria-label="État des services">
        <p>API : {config.gatewayUrl ? 'disponible' : 'pas encore publiée'}</p>
        <p>Temps réel : {config.firestore ? 'disponible' : 'pas encore configuré'}</p>
      </section>
    </main>
  );
}
