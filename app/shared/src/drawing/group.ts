import { Timestamp, type DocumentReference, type Firestore, type Transaction } from '@google-cloud/firestore';
import {
  COLLECTIONS, DELTA_ENCODING_VERSION, compareEvents, countBatchDocuments, encodeDelta, evaluateRateLimit,
  groupPixelsByRegion, groupPixelsByTile, isInsideGrid, resolveRateLimit, RATE_LIMIT_WINDOW_MS,
  type DrawPixel, type GlobalConfigDocument, type RateLimitOverrideDocument, type TileColorsDocument,
  type TileMetadataDocument, type UserStateDocument,
} from '../grid';
import {
  DrawProcessingError, MAX_DRAW_AGE_MS, RESULT_RETENTION_MS, assertNotFuture, drawOptions, prepareDraw,
  processingTime, storedResult,
  type DrawCommand, type DrawOptions, type DrawResult, type PreparedDraw,
} from './command';
import { estimateTileBytes, planTileChanges } from './tiles';
import { runDrawTransaction } from './retry';
import { expandedBounds, validateConfig } from './transaction';

/**
 * The group does not fit one transaction (documents or bytes). Not a business refusal:
 * the caller processes each command alone instead (ADR-0014, group commit).
 */
export class DrawGroupTooLargeError extends Error {
  constructor() { super('Draw group exceeds the transaction budget'); this.name = 'DrawGroupTooLargeError'; }
}

type Decision =
  | { type: 'pixel-rejected'; reason: NonNullable<DrawResult['reason']>; quota?: DrawResult['quota'] }
  | { type: 'pixel-processed'; applied: DrawPixel[]; quota?: DrawResult['quota'] };

interface Person {
  ref: DocumentReference;
  exists: boolean;
  override: RateLimitOverrideDocument | null;
  limit: number;
  usage: UserStateDocument | null;
  accepted: boolean;
  /** undefined: unchanged; null: cleared by an accepted draw; object: last refusal. */
  rejection?: { event_id: string; reason: string } | null;
}

/**
 * Where the time of one group transaction goes (DRAW-05): reads of the LAST attempt, and the
 * whole transaction, retries included (runDrawTransaction). attempts > 1 means Firestore aborted the
 * transaction on contention (another one wrote a document it read) and it was replayed.
 */
export interface GroupTiming {
  attempts: number;
  read_processed_ms: number;
  read_people_ms: number;
  read_tiles_ms: number;
  /** The last attempt: from its start to the end of our code (reads and computation). */
  work_ms: number;
  /** The last attempt: from the end of our code to Firestore's answer, i.e. the commit. */
  commit_ms: number;
  transaction_ms: number;
}

interface TileState {
  id: string; tx: number; ty: number; region: string;
  colors?: TileColorsDocument; metadata?: TileMetadataDocument;
  estimated_bytes: number; touched: boolean;
}

/**
 * Group commit of ADR-0014: the draws an instance received at the same time, applied in ONE
 * transaction. Each command keeps its own deduplication, quota decision (in compareEvents
 * order, pixel by pixel), last-write-wins per pixel and durable result, exactly as
 * createDrawProcessor would produce them one after the other. users/{uid}, each tile and
 * config/global are written once per group instead of once per pixel.
 *
 * Any error fails the whole group and nothing is written: the caller then processes each
 * command alone, so that one faulty command never blocks the others.
 *
 * A command of a reserved source (ADR-0017) skips the quota: its users/{uid} is neither read
 * nor written when it is accepted, so that the transactions of one web user stop colliding
 * on that document. It is read and written only to remember a refusal (last_rejection).
 */
export function createGroupDrawProcessor(db: Firestore, options: DrawOptions = {}, onTiming?: (timing: GroupTiming) => void) {
  const settings = drawOptions(options);
  const ref = (path: string) => db.doc(settings.root ? `${settings.root}/${path}` : path);

  return async (inputs: readonly DrawCommand[]): Promise<DrawResult[]> => {
    if (inputs.length < 1) throw new Error('A draw group needs at least one command');
    // Validated before any Firestore call: a malformed command fails fast.
    const commands = inputs.map((input) => prepareDraw(input, settings.max_pixels));
    const unique = new Map<string, PreparedDraw>();
    for (const command of commands) {
      const first = unique.get(command.event_id);
      if (first && first.request_digest !== command.request_digest) {
        throw new DrawProcessingError('event_id_conflict', 'An event ID was reused for different business content');
      }
      if (!first) unique.set(command.event_id, command);
    }

    const timing: GroupTiming = { attempts: 0, read_processed_ms: 0, read_people_ms: 0, read_tiles_ms: 0, work_ms: 0, commit_ms: 0, transaction_ms: 0 };
    const timed = async <T>(field: 'read_processed_ms' | 'read_people_ms' | 'read_tiles_ms', read: Promise<T>): Promise<T> => {
      const started = performance.now();
      try { return await read; } finally { timing[field] = Math.round(performance.now() - started); }
    };
    const apply = async (tx: Transaction): Promise<Map<string, DrawResult>> => {
      timing.attempts += 1;
      timing.read_processed_ms = 0; timing.read_people_ms = 0; timing.read_tiles_ms = 0;
      const distinct = [...unique.values()];
      const stored = await timed('read_processed_ms', tx.getAll(...distinct.map((c) => ref(`${COLLECTIONS.processed}/${c.event_id}`))));
      const done = new Map<string, DrawResult>();
      const pending: PreparedDraw[] = [];
      distinct.forEach((command, index) => {
        if (stored[index].exists) done.set(command.event_id, storedResult(stored[index].data()!, command));
        else pending.push(command);
      });
      if (!pending.length) return done;

      const configRef = ref(`${COLLECTIONS.config}/global`);
      const reserved = (command: PreparedDraw) => settings.reserved_sources.has(command.source);
      const allUids = [...new Set(pending.map((c) => c.author.uid))];
      // Only the users whose quota this transaction evaluates: never the reserved ones.
      const uids = [...new Set(pending.filter((c) => !reserved(c)).map((c) => c.author.uid))];
      const snapshots = await timed('read_people_ms', tx.getAll(configRef, ...uids.flatMap((uid) => [
        ref(`${COLLECTIONS.overrides}/${uid}`), ref(`${COLLECTIONS.users}/${uid}`),
      ])));
      const config = snapshots[0].data() as GlobalConfigDocument;
      validateConfig(config);
      const people = new Map<string, Person>(uids.map((uid, i) => {
        const override = snapshots[1 + i * 2];
        const user = snapshots[2 + i * 2];
        const overrideData = override.exists ? override.data() as RateLimitOverrideDocument : null;
        return [uid, {
          ref: ref(`${COLLECTIONS.users}/${uid}`), exists: user.exists, override: overrideData,
          limit: resolveRateLimit(config, overrideData), // Fail closed even for a paused/expired command.
          usage: user.exists ? user.data() as UserStateDocument : null, accepted: false,
        }];
      }));
      let now = processingTime(settings.now, settings.delta_ttl_ms);
      for (const command of pending) assertNotFuture(command, now);

      // Same order as one transaction per command would converge to (event-order.ts).
      const ordered = [...pending].sort(compareEvents);
      const decisions = new Map<string, Decision>();
      const reject = (command: PreparedDraw, reason: NonNullable<DrawResult['reason']>, quota?: DrawResult['quota']) => {
        decisions.set(command.event_id, { type: 'pixel-rejected', reason, ...(quota ? { quota } : {}) });
      };

      const candidates: PreparedDraw[] = [];
      for (const command of ordered) {
        if (now - command.occurred_ms > MAX_DRAW_AGE_MS) reject(command, 'expired');
        else if (config.paused) reject(command, 'paused');
        else if (command.pixels.some((pixel) => !isInsideGrid(pixel, config.size))) reject(command, 'out_of_bounds');
        else candidates.push(command);
      }

      const tiles = new Map<string, TileState>();
      const commandTiles = new Map<string, ReturnType<typeof groupPixelsByTile>>();
      for (const command of candidates) {
        const groups = groupPixelsByTile(command.pixels, config.canvas_version, settings.max_pixels);
        commandTiles.set(command.event_id, groups);
        for (const [id, tile] of groups) {
          if (!tiles.has(id)) tiles.set(id, { id, tx: tile.tx, ty: tile.ty, region: tile.region, estimated_bytes: 0, touched: false });
        }
      }
      if (candidates.length) {
        const regions = new Set([...tiles.values()].map((tile) => tile.region));
        // Tiles (colors + metadata), deltas, one result per command, users and config.
        const documents = countBatchDocuments(tiles.size, regions.size) + pending.length + allUids.length + 1;
        if (documents > settings.max_write_documents) throw new DrawGroupTooLargeError();

        // All tile reads before ANY write. Refresh the worker clock after reads.
        const entries = [...tiles.values()];
        const read = await timed('read_tiles_ms', tx.getAll(...entries.flatMap((tile) => [
          ref(`${COLLECTIONS.colors}/${tile.id}`), ref(`${COLLECTIONS.metadata}/${tile.id}`),
        ])));
        entries.forEach((tile, index) => {
          tile.colors = read[index * 2].data() as TileColorsDocument | undefined;
          tile.metadata = read[index * 2 + 1].data() as TileMetadataDocument | undefined;
        });
        now = processingTime(settings.now, settings.delta_ttl_ms);
        for (const command of candidates) assertNotFuture(command, now);
      }

      // Final pixel of each coordinate: two commands of the group may paint the same one.
      const finalPixels = new Map<string, DrawPixel>();
      const allApplied: DrawPixel[] = [];
      for (const command of candidates) {
        if (now - command.occurred_ms > MAX_DRAW_AGE_MS) { reject(command, 'expired'); continue; }
        let quota: DrawResult['quota'];
        if (!reserved(command)) {
          const person = people.get(command.author.uid)!;
          const decision = evaluateRateLimit({
            config, override: person.override, usage: person.usage, now_ms: now, pixel_count: command.pixels.length,
          });
          if (!decision.allowed) { reject(command, 'rate_limit', decision); continue; }
          const next = decision.next_usage;
          person.usage = {
            window_start: Timestamp.fromMillis(next.window_start_ms), used_pixels: next.used_pixels,
            limit_per_minute: next.limit_per_minute, updated_at: Timestamp.fromMillis(next.updated_at_ms), last_rejection: null,
          };
          person.accepted = true;
          quota = decision;
        }
        const applied: DrawPixel[] = [];
        for (const [id, group] of commandTiles.get(command.event_id)!) {
          const tile = tiles.get(id)!;
          // The previous command's planned documents are this one's input: last-write-wins
          // between commands of the group, exactly as between consecutive transactions.
          // Validated once, when read from Firestore; its size is estimated once, below: per
          // command, both walked the whole tile (7.3 s for 127 pixels on a full tile, 28/11).
          const plan = planTileChanges({ id, tx: tile.tx, ty: tile.ty, pixels: group.pixels, colors: tile.colors, metadata: tile.metadata },
            command, config.canvas_version, now, { trusted: tile.touched, estimate: false });
          if (!plan.applied.length) continue;
          tile.colors = plan.colors; tile.metadata = plan.metadata;
          tile.touched = true;
          applied.push(...plan.applied);
        }
        for (const pixel of applied) finalPixels.set(`${pixel.x},${pixel.y}`, pixel);
        allApplied.push(...applied);
        decisions.set(command.event_id, { type: 'pixel-processed', applied, ...(quota ? { quota } : {}) });
      }

      const touched = [...tiles.values()].filter((tile) => tile.touched);
      for (const tile of touched) tile.estimated_bytes = estimateTileBytes(tile.metadata!, tile.colors!.colors);
      const estimatedBytes = touched.reduce((sum, tile) => sum + tile.estimated_bytes, 0)
        + allApplied.length * 5 + 16_384; // Headroom for config, users, results and document framing.
      if (estimatedBytes > settings.max_estimated_bytes) throw new DrawGroupTooLargeError();

      // Last refusal since the last accepted draw, in event order: some refusals are decided
      // before the accepted draws (pause, bounds), but may come after them in time.
      // An accepted reserved command does not touch users/{uid}, so it does not clear a refusal
      // either: same result as one transaction per command.
      const lastRejection = new Map<string, Person['rejection']>();
      for (const command of ordered) {
        const decision = decisions.get(command.event_id)!;
        if (decision.type === 'pixel-rejected') lastRejection.set(command.author.uid, { event_id: command.event_id, reason: decision.reason });
        else if (!reserved(command)) lastRejection.set(command.author.uid, null);
      }
      for (const [uid, rejection] of lastRejection) { const person = people.get(uid); if (person) person.rejection = rejection; }
      // Reserved-only users are read only when their last command of the group was refused,
      // still before any write; an accepted reserved command leaves users/{uid} alone.
      const refusedReserved = [...lastRejection].filter(([uid, rejection]) => rejection && !people.has(uid)).map(([uid]) => uid);
      if (refusedReserved.length) {
        const read = await tx.getAll(...refusedReserved.map((uid) => ref(`${COLLECTIONS.users}/${uid}`)));
        refusedReserved.forEach((uid, index) => people.set(uid, {
          ref: ref(`${COLLECTIONS.users}/${uid}`), exists: read[index].exists, override: null,
          limit: resolveRateLimit(config, null), usage: read[index].exists ? read[index].data() as UserStateDocument : null,
          accepted: false, rejection: lastRejection.get(uid),
        }));
      }
      for (const tile of touched) {
        tx.set(ref(`${COLLECTIONS.colors}/${tile.id}`), tile.colors!);
        tx.set(ref(`${COLLECTIONS.metadata}/${tile.id}`), tile.metadata!);
      }
      if (finalPixels.size) {
        // One delta per region for the whole group, named after its first applied command.
        const key = ordered.find((c) => { const d = decisions.get(c.event_id); return d?.type === 'pixel-processed' && d.applied.length; })!.event_id;
        for (const [region, group] of groupPixelsByRegion([...finalPixels.values()], finalPixels.size)) {
          tx.create(ref(`${COLLECTIONS.deltas}/v${config.canvas_version}_${key}_${region}`), {
            encoding_version: DELTA_ENCODING_VERSION, canvas_version: config.canvas_version,
            region, event_id: key, created_at: Timestamp.fromMillis(now),
            expire_at: Timestamp.fromMillis(now + settings.delta_ttl_ms),
            pixels: Buffer.from(encodeDelta(group.pixels, finalPixels.size)),
          });
        }
      }
      const at = Timestamp.fromMillis(now);
      for (const person of people.values()) {
        const lastRejection = person.rejection ? { ...person.rejection, at } : null;
        if (person.accepted) {
          const usage = person.usage!;
          tx.set(person.ref, {
            window_start: usage.window_start, used_pixels: usage.used_pixels, limit_per_minute: usage.limit_per_minute,
            updated_at: usage.updated_at, last_rejection: lastRejection,
          }, { merge: true });
        } else if (person.exists) {
          tx.update(person.ref, { last_rejection: lastRejection, updated_at: at });
        } else {
          // First action refused: created with nothing consumed (DRAW-04, drawing-transactions.md).
          tx.set(person.ref, {
            window_start: Timestamp.fromMillis(Math.floor(now / RATE_LIMIT_WINDOW_MS) * RATE_LIMIT_WINDOW_MS),
            used_pixels: 0, limit_per_minute: person.limit, updated_at: at, last_rejection: lastRejection,
          });
        }
      }
      if (allApplied.length) {
        const bounds = expandedBounds(config.bounds, allApplied);
        if (JSON.stringify(bounds) !== JSON.stringify(config.bounds)) tx.update(configRef, { bounds });
      }

      for (const command of pending) {
        const decision = decisions.get(command.event_id)!;
        const base: DrawResult = {
          schema_version: 1, result_id: `draw-result:${command.event_id}`,
          event_id: command.event_id, occurred_at: command.occurred_at,
          processed_at: new Date(now).toISOString(), source: command.source, uid: command.author.uid,
          canvas_version: config.canvas_version, type: 'pixel-processed',
          requested_pixels: command.pixels.length, applied_pixels: 0, ignored_pixels: 0, regions: [],
        };
        const result: DrawResult = decision.type === 'pixel-rejected'
          ? { ...base, type: 'pixel-rejected', reason: decision.reason, ...(decision.quota ? { quota: decision.quota } : {}) }
          : {
            ...base, applied_pixels: decision.applied.length, ignored_pixels: command.pixels.length - decision.applied.length,
            regions: decision.applied.length ? [...groupPixelsByRegion(decision.applied, settings.max_pixels).keys()].sort() : [],
            ...(decision.quota ? { quota: decision.quota } : {}),
          };
        tx.create(ref(`${COLLECTIONS.processed}/${command.event_id}`), {
          schema_version: 1, event_id: command.event_id, request_digest: command.request_digest,
          canvas_version: result.canvas_version, status: result.type === 'pixel-processed' ? 'processed' : 'rejected',
          created_at: at, expire_at: Timestamp.fromMillis(now + RESULT_RETENTION_MS), result,
        });
        done.set(command.event_id, result);
      }
      return done;
    };
    const started = performance.now();
    let workEnded = started;
    const results = await runDrawTransaction(db, async (tx) => {
      const workStarted = performance.now();
      try { return await apply(tx); } finally {
        workEnded = performance.now();
        timing.work_ms = Math.round(workEnded - workStarted);
      }
    }).finally(() => {
      const ended = performance.now();
      timing.transaction_ms = Math.round(ended - started);
      timing.commit_ms = Math.round(ended - workEnded);
      try { onTiming?.(timing); } catch { /* Observability never fails a draw. */ }
    });
    return commands.map((command) => results.get(command.event_id)!);
  };
}
