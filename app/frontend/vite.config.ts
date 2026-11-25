import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

// Gateway of the environment used by the local server (e.g. the dev gateway).
const gateway = process.env.GATEWAY_URL ?? '';

// The gateway only allows the Cloud Run origin of the frontend (CORS). Locally, the page
// calls its own origin and Vite forwards the API routes, so no CORS is involved and the
// infrastructure stays untouched. /auth/callback is a page route: it is not forwarded.
const GATEWAY_ROUTES = ['/auth/login', '/auth/exchange', '/api/'];

// In production nginx serves /config.js from the container environment (ADR-0011).
// The development server serves the same file from the shell environment instead.
function localConfig(): Plugin {
  return {
    name: 'pixelwar-local-config',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/config.js', (request, response) => {
        const config = {
          environment: 'local',
          gatewayUrl: gateway && request.headers.host ? `http://${request.headers.host}` : '',
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
  server: {
    proxy: gateway
      ? Object.fromEntries(GATEWAY_ROUTES.map((route) => [route, {
          target: gateway,
          changeOrigin: true,
          // Same treatment as a server-to-server call: the gateway sees no browser origin.
          configure: (proxy) => proxy.on('proxyReq', (proxyRequest) => proxyRequest.removeHeader('origin')),
        }]))
      : undefined,
  },
  build: {
    // No inline script or style: the Content-Security-Policy of nginx forbids them.
    assetsInlineLimit: 0,
    sourcemap: false,
  },
});
