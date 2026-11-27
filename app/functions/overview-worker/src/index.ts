import { Firestore } from '@google-cloud/firestore';
import type { HttpFunction } from '@google-cloud/functions-framework';
import { Storage } from '@google-cloud/storage';
import { runOverviewCycle, type CycleSummary } from './cycle';
import { InvalidTickMessage, MAX_PUSH_BYTES, parseTickPush } from './message';
import { ConcurrentCycleError, StoredDataError, createFirestoreOverviewStore, createGcsOverviewBucket } from './store';

/** A tick is worth one cycle only while it is fresh: a late redelivery would just repeat the next one. */
export const STALE_TICK_MS = 2 * 60_000;

export type RunCycle = () => Promise<CycleSummary>;

interface Options {
  subscription?: string;
  cycle?: RunCycle;
  now?: () => number;
  write?: (line: string) => void;
}

/** DATA-05c: keeps the far-view pyramid of the overview bucket up to date, once per Cloud Scheduler tick. */
export function createOverviewWorkerHandler(options: Options): HttpFunction {
  const write = options.write ?? ((line: string) => { process.stdout.write(line); });
  const now = options.now ?? Date.now;
  const log = (severity: string, eventType: string, fields: Record<string, unknown> = {}) => {
    try { write(`${JSON.stringify({ severity, function: 'overview-worker', event_type: eventType, ...fields })}\n`); }
    catch { /* Logging never fails a cycle. */ }
  };
  return async (req, res): Promise<void> => {
    if (!options.subscription || !options.cycle) { res.status(503).json({ error: 'Overview worker unavailable.' }); return; }
    if (req.path !== '/') { res.status(404).json({ error: 'Not found.' }); return; }
    if (req.method !== 'POST') { res.set('Allow', 'POST').status(405).json({ error: 'Method not allowed.' }); return; }
    if (!Buffer.isBuffer(req.rawBody) || req.rawBody.length > MAX_PUSH_BYTES) {
      res.status(413).json({ error: 'Invalid push body size.' }); return;
    }
    let tick;
    try { tick = parseTickPush(req.body, options.subscription); } catch (error) {
      if (!(error instanceof InvalidTickMessage)) throw error;
      log('WARNING', 'overview.message.invalid', { reason: error.reason });
      res.status(400).json({ error: 'Invalid tick.' }); return;
    }
    if (now() - tick.published_ms > STALE_TICK_MS) {
      log('INFO', 'overview.tick.stale', { message_id: tick.message_id });
      res.status(204).send(); return;
    }
    const started = now();
    try {
      const summary = await options.cycle();
      log('INFO', 'overview.cycle.done', { message_id: tick.message_id, duration_ms: now() - started, ...summary });
    } catch (error) {
      if (error instanceof ConcurrentCycleError) {
        // Another cycle wrote the state first: its result stands, this tick is done.
        log('WARNING', 'overview.cycle.concurrent', { message_id: tick.message_id });
        res.status(204).send(); return;
      }
      // Never log the error itself: it may carry stored data or a signed request.
      log('ERROR', 'overview.cycle.failed', { message_id: tick.message_id, ...(error instanceof StoredDataError ? { reason: 'stored_data' } : {}) });
      res.status(503).json({ error: 'Overview cycle unavailable.' }); return;
    }
    res.status(204).send();
  };
}

/** Production cycle: clients created on first use and reused by the next ticks of the instance. */
export function createLazyCycle(projectId: string, bucketName: string): RunCycle {
  let clients: { store: ReturnType<typeof createFirestoreOverviewStore>; bucket: ReturnType<typeof createGcsOverviewBucket> } | undefined;
  return () => {
    clients ??= {
      store: createFirestoreOverviewStore(new Firestore({ projectId })),
      bucket: createGcsOverviewBucket(new Storage({ projectId }), bucketName),
    };
    return runOverviewCycle({ ...clients, now: Date.now });
  };
}

const projectId = process.env.GOOGLE_CLOUD_PROJECT;
const bucketName = process.env.OVERVIEW_BUCKET;
export const handleOverviewWorker = createOverviewWorkerHandler({
  subscription: process.env.OVERVIEW_TICK_SUBSCRIPTION,
  cycle: projectId && bucketName ? createLazyCycle(projectId, bucketName) : undefined,
});
