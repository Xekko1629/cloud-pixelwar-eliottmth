import { useMemo } from 'react';
import { PixelCanvas } from './canvas/PixelCanvas';
import { createFakeTileSource } from './canvas/tiles';
import type { FrontendConfig } from './config';

// Shell of the application (WEB-01). The canvas shows fake tiles until tile-reader is
// wired (WEB-03b); the Discord login (WEB-02b) mounts in the header.
export function App({ config }: { config: FrontendConfig }) {
  const source = useMemo(() => createFakeTileSource(), []);

  return (
    <main className="app">
      <header className="app__header">
        <h1>Pixel War</h1>
        <span className="app__environment" data-environment={config.environment}>{config.environment}</span>
        <span className="app__status">Données factices</span>
      </header>
      <section className="app__status" aria-label="État des services">
        <p>API : {config.gatewayUrl ? 'disponible' : 'pas encore publiée'}</p>
        <p>Temps réel : {config.firestore ? 'disponible' : 'pas encore configuré'}</p>
      </section>
      <PixelCanvas source={source} />
    </main>
  );
}
