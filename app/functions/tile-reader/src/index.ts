import { randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { Firestore } from '@google-cloud/firestore';
import type { HttpFunction } from '@google-cloud/functions-framework';
import { GATEWAY_USERINFO_HEADER, gatewayIdentity } from '@pixelwar/shared/gateway';
import { createLogger } from '@pixelwar/shared/observability/logger';
import { createFunctionTelemetry, type FunctionTelemetry } from '@pixelwar/shared/observability/function';
import { InvalidRoute, etagOf, matchesEtag, metaBody, parseRoute, regionBody, stateBody, type Route } from './responses';
import { createFirestoreTileStore, type TileStore } from './store';
import { answerHealth } from '@pixelwar/shared/health';

interface Options {
  /** https://frontend-<project number>.<region>.run.app, the only origin allowed by CORS. */
  frontendOrigin?: string;
  store?: TileStore;
  now?: () => number;
  log?: ReturnType<typeof createLogger>;
  telemetry?: FunctionTelemetry;
}

const SPANS: Record<Route['kind'], string> = { tiles: 'tiles.region.read', meta: 'tiles.meta.read', state: 'state.read' };
const CONTENT_TYPES: Record<Route['kind'], string> = {
  tiles: 'application/octet-stream', meta: 'application/json; charset=utf-8', state: 'application/json; charset=utf-8',
};

/** SRV-11: the browser's only read path to Firestore, behind the gateway and the session JWT (ADR-0013). */
export function createTileReaderHandler(options: Options): HttpFunction {
  const now = options.now ?? Date.now;
  const log = options.log ?? createLogger({ serviceName: 'tile-reader', projectId: process.env.GOOGLE_CLOUD_PROJECT ?? '' });
  const telemetry = options.telemetry ?? createFunctionTelemetry('tile-reader', {
    writeLog: options.log ? (line) => {
      const record = JSON.parse(line);
      log(record.severity, record.message ?? 'Telemetry unavailable.', { event_type: record.event_type });
    } : undefined,
  });
  const refuse = (reason: string) => log('WARNING', 'Read request refused.', { event_type: `tile_reader.refused.${reason}` });

  return async (req, res): Promise<void> => {
    // Warmer (ADR-0017): before any configuration check, without log or side effect.
    if (answerHealth(req, res)) return;
    // Error answers are never cached; successful reads are revalidated with their ETag.
    res.set('Cache-Control', 'no-store');
    let route: Route | undefined;
    try { route = parseRoute(req.path); } catch (error) {
      if (!(error instanceof InvalidRoute)) throw error;
      refuse('invalid_coordinates'); res.status(400).json({ error: 'invalid_coordinates' }); return;
    }
    if (!route) { res.status(404).json({ error: 'not_found' }); return; }
    const origin = req.get('Origin');
    const allowed = origin !== undefined && origin === options.frontendOrigin;
    if (allowed) res.set({ 'Access-Control-Allow-Origin': origin, 'Access-Control-Expose-Headers': 'ETag' });
    res.set('Vary', 'Origin, Accept-Encoding');
    if (req.method === 'OPTIONS') {
      if (!allowed) { res.status(403).json({ error: 'origin_not_allowed' }); return; }
      res.set({
        'Access-Control-Allow-Methods': 'GET',
        'Access-Control-Allow-Headers': 'Authorization',
        'Access-Control-Max-Age': '600',
      }).status(204).send();
      return;
    }
    if (req.method !== 'GET') { res.set('Allow', 'GET').status(405).json({ error: 'method_not_allowed' }); return; }
    if (!options.store || !options.frontendOrigin) { res.status(503).json({ error: 'unavailable' }); return; }
    const identity = gatewayIdentity(req.get(GATEWAY_USERINFO_HEADER));
    if (!identity) { refuse('invalid_identity'); res.status(401).json({ error: 'unauthenticated' }); return; }

    const store = options.store;
    const current = route;
    let body: Buffer;
    try {
      body = await telemetry.request(randomUUID(), async (operation) => {
        operation.source('web');
        operation.outcome('error', 'processing');
        const config = await store.config();
        const version = config.canvas_version;
        let result: Buffer;
        if (current.kind === 'tiles') result = regionBody(version, current, await store.regionTiles(version, current.region));
        else if (current.kind === 'meta') result = metaBody(version, current, await store.tileAuthors(version, current.tx, current.ty));
        // Only the caller's own document: the uid comes from the session, never from the URL.
        else result = stateBody(config, await store.user(identity.uid), now());
        operation.outcome('served');
        return result;
      }, SPANS[current.kind]);
    } catch {
      // Never log the error: it may carry stored data. The read is retryable by the browser.
      log('ERROR', 'Read failed.', { event_type: 'tile_reader.read_failed' });
      res.status(503).json({ error: 'read_unavailable' }); return;
    }

    const etag = etagOf(body);
    res.set({ 'Cache-Control': 'private, no-cache', ETag: etag });
    if (matchesEtag(req.get('If-None-Match'), etag)) { res.status(304).send(); return; }
    res.set('Content-Type', CONTENT_TYPES[current.kind]);
    // Untouched pixels are zeros: a full region compresses from about 1 MiB to a few KiB.
    if (current.kind === 'tiles' && /\bgzip\b/i.test(req.get('Accept-Encoding') ?? '')) {
      res.set('Content-Encoding', 'gzip').status(200).send(gzipSync(body)); return;
    }
    res.status(200).send(body);
  };
}

export const handleTileReader = createTileReaderHandler({
  frontendOrigin: process.env.FRONTEND_ORIGIN,
  store: process.env.GOOGLE_CLOUD_PROJECT ? createFirestoreTileStore(new Firestore({ projectId: process.env.GOOGLE_CLOUD_PROJECT })) : undefined,
});
