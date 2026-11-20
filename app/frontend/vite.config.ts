import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

// In production nginx serves /config.js from the container environment (ADR-0011).
// The development server serves the same file from the shell environment instead.
function localConfig(): Plugin {
  return {
    name: 'pixelwar-local-config',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/config.js', (_request, response) => {
        const config = {
          environment: 'local',
          gatewayUrl: process.env.GATEWAY_URL ?? '',
          firestoreProjectId: process.env.FIRESTORE_PROJECT_ID ?? '',
          firestoreApiKey: process.env.FIRESTORE_API_KEY ?? '',
          discordClientId: process.env.DISCORD_CLIENT_ID ?? '',
        };
        response.setHeader('Content-Type', 'application/javascript');
        response.end(`window.__PIXELWAR_CONFIG__ = ${JSON.stringify(config)};\n`);
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), localConfig()],
  build: {
    // No inline script or style: the Content-Security-Policy of nginx forbids them.
    assetsInlineLimit: 0,
    sourcemap: false,
  },
});
