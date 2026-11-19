import { Timestamp, type Firestore } from '@google-cloud/firestore';
import {
  COLLECTIONS, DELTA_ENCODING_VERSION, assertCanvasVersion, countBatchDocuments,
  encodeDelta, evaluateRateLimit, groupPixelsByRegion, groupPixelsByTile, isInsideGrid,
  resolveRateLimit, validateGridSize,
  type Bounds, type GlobalConfigDocument, type RateLimitOverrideDocument,
  type TileColorsDocument, type TileMetadataDocument, type UserStateDocument,
} from '../grid';
import {
  DrawProcessingError, MAX_DRAW_AGE_MS, RESULT_RETENTION_MS, assertNotFuture, drawOptions,
  prepareDraw, processingTime, storedResult,
  type DrawCommand, type DrawOptions, type DrawResult, type PreparedDraw,
} from './command';
import { planTileChanges } from './tiles';

function validateConfig(config: GlobalConfigDocument): void {
  try {
    if (!config || typeof config.paused !== 'boolean') throw new Error();
    assertCanvasVersion(config.canvas_version);
    validateGridSize(config.size);
    if (config.bounds !== null) {
      const b = config.bounds;
      if (![b.min_x, b.min_y, b.max_x, b.max_y].every(Number.isSafeInteger) || b.min_x > b.max_x || b.min_y > b.max_y) throw new Error();
    }
  } catch {
    throw new DrawProcessingError('invalid_state', 'Missing or invalid global canvas configuration');
  }
}

/** No network call is made until the returned function is invoked. Node-only API. */
export function createDrawProcessor(db: Firestore, options: DrawOptions = {}) {
  const settings = drawOptions(options);
  const ref = (path: string) => db.doc(settings.root ? `${settings.root}/${path}` : path);

  return async (input: DrawCommand): Promise<DrawResult> => {
    const command = prepareDraw(input, settings.max_pixels);
    const eventRef = ref(`${COLLECTIONS.processed}/${command.event_id}`);
    const userRef = ref(`${COLLECTIONS.users}/${command.author.uid}`);
    const configRef = ref(`${COLLECTIONS.config}/global`);
    return db.runTransaction(async (tx) => {
      const existing = await tx.get(eventRef);
      if (existing.exists) return storedResult(existing.data()!, command);

      const [global, override, user] = await tx.getAll(configRef, ref(`${COLLECTIONS.overrides}/${command.author.uid}`), userRef);
      const config = global.data() as GlobalConfigDocument;
      validateConfig(config);
      const overrideData = override.exists ? override.data() as RateLimitOverrideDocument : null;
      resolveRateLimit(config, overrideData); // Fail closed even for a paused/expired command.
      const usage = user.exists ? user.data() as UserStateDocument : null;
      let now = processingTime(settings.now, settings.delta_ttl_ms);
      assertNotFuture(command, now);

      const makeResult = (): DrawResult => ({
        schema_version: 1, result_id: `draw-result:${command.event_id}`,
        event_id: command.event_id, occurred_at: command.occurred_at,
        processed_at: new Date(now).toISOString(), source: command.source, uid: command.author.uid,
        canvas_version: config.canvas_version, type: 'pixel-processed',
        requested_pixels: command.pixels.length, applied_pixels: 0, ignored_pixels: 0, regions: [],
      });
      const persist = (result: DrawResult): DrawResult => {
        tx.create(eventRef, {
          schema_version: 1, event_id: command.event_id, request_digest: command.request_digest,
          canvas_version: result.canvas_version, status: result.type === 'pixel-processed' ? 'processed' : 'rejected',
          created_at: Timestamp.fromMillis(now), expire_at: Timestamp.fromMillis(now + RESULT_RETENTION_MS), result,
        });
        return result;
      };
      const reject = (reason: DrawResult['reason'], quota?: DrawResult['quota']): DrawResult => {
        const result = { ...makeResult(), type: 'pixel-rejected' as const, reason: reason! };
        const rejection = { event_id: command.event_id, reason: reason!, at: Timestamp.fromMillis(now) };
        // Preserve quota/window on rejection. A missing user document is left absent.
        if (user.exists) tx.update(userRef, { last_rejection: rejection, updated_at: Timestamp.fromMillis(now) });
        return persist(quota ? { ...result, quota } : result);
      };
      if (now - command.occurred_ms > MAX_DRAW_AGE_MS) return reject('expired');
      if (config.paused) return reject('paused');
      if (command.pixels.some((pixel) => !isInsideGrid(pixel, config.size))) return reject('out_of_bounds');

      const tiles = groupPixelsByTile(command.pixels, config.canvas_version, settings.max_pixels);
      const regions = groupPixelsByRegion(command.pixels, settings.max_pixels);
      if (countBatchDocuments(tiles.size, regions.size) + 3 > settings.max_write_documents) return reject('batch_budget_exceeded');
      let quota = evaluateRateLimit({ config, override: overrideData, usage, now_ms: now, pixel_count: command.pixels.length });
      if (!quota.allowed) return reject('rate_limit', quota);

      // All tile reads before ANY write. Refresh the worker clock/quota after reads.
      const entries = [...tiles.entries()];
      const snapshots = await tx.getAll(...entries.flatMap(([id]) => [
        ref(`${COLLECTIONS.colors}/${id}`), ref(`${COLLECTIONS.metadata}/${id}`),
      ]));
      now = processingTime(settings.now, settings.delta_ttl_ms);
      assertNotFuture(command, now);
      if (now - command.occurred_ms > MAX_DRAW_AGE_MS) return reject('expired');
      quota = evaluateRateLimit({ config, override: overrideData, usage, now_ms: now, pixel_count: command.pixels.length });
      if (!quota.allowed) return reject('rate_limit', quota);

      const plans = entries.map(([id, tile], index) => planTileChanges({
        id, ...tile,
        colors: snapshots[index * 2].data() as TileColorsDocument | undefined,
        metadata: snapshots[index * 2 + 1].data() as TileMetadataDocument | undefined,
      }, command, config.canvas_version, now));
      const applied = plans.flatMap((plan) => plan.applied);
      const appliedRegions = applied.length ? groupPixelsByRegion(applied, settings.max_pixels) : new Map();
      const estimatedBytes = plans.filter((plan) => plan.applied.length).reduce((sum, plan) => sum + plan.estimated_bytes, 0)
        + applied.length * 5 + 16_384; // Headroom for config, user, result and document framing.
      if (estimatedBytes > settings.max_estimated_bytes) return reject('batch_budget_exceeded');

      for (let index = 0; index < plans.length; index++) {
        if (!plans[index].applied.length) continue;
        tx.set(ref(`${COLLECTIONS.colors}/${entries[index][0]}`), plans[index].colors);
        tx.set(ref(`${COLLECTIONS.metadata}/${entries[index][0]}`), plans[index].metadata);
      }
      for (const [region, group] of appliedRegions) {
        const id = `v${config.canvas_version}_${command.event_id}_${region}`;
        tx.create(ref(`${COLLECTIONS.deltas}/${id}`), {
          encoding_version: DELTA_ENCODING_VERSION, canvas_version: config.canvas_version,
          region, event_id: command.event_id, created_at: Timestamp.fromMillis(now),
          expire_at: Timestamp.fromMillis(now + settings.delta_ttl_ms),
          pixels: Buffer.from(encodeDelta(group.pixels, settings.max_pixels)),
        });
      }
      const next = quota.next_usage;
      tx.set(userRef, {
        window_start: Timestamp.fromMillis(next.window_start_ms), used_pixels: next.used_pixels,
        limit_per_minute: next.limit_per_minute, updated_at: Timestamp.fromMillis(next.updated_at_ms), last_rejection: null,
      }, { merge: true });
      if (applied.length) {
        const bounds = expandedBounds(config.bounds, applied);
        if (JSON.stringify(bounds) !== JSON.stringify(config.bounds)) tx.update(configRef, { bounds });
      }
      return persist({
        ...makeResult(), applied_pixels: applied.length, ignored_pixels: command.pixels.length - applied.length,
        regions: [...appliedRegions.keys()].sort(), quota,
      });
    });
  };
}

function expandedBounds(bounds: Bounds | null, pixels: PreparedDraw['pixels']): Bounds {
  const result = bounds ? { ...bounds } : { min_x: pixels[0].x, min_y: pixels[0].y, max_x: pixels[0].x, max_y: pixels[0].y };
  for (const pixel of pixels) {
    result.min_x = Math.min(result.min_x, pixel.x);
    result.min_y = Math.min(result.min_y, pixel.y);
    result.max_x = Math.max(result.max_x, pixel.x);
    result.max_y = Math.max(result.max_y, pixel.y);
  }
  return result;
}

/** Resolve only after publication succeeds. The future push adapter can then send 204. */
export async function processAndPublishDraw(
  process: (command: DrawCommand) => Promise<DrawResult>,
  publish: (result: DrawResult) => Promise<void>, command: DrawCommand,
): Promise<DrawResult> {
  const result = await process(command);
  await publish(result);
  return result;
}
