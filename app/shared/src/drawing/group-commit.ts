import type { DrawCommand, DrawResult } from './command';
import { isRetryableTransactionError } from './retry';

export type ProcessOne = (command: DrawCommand) => Promise<DrawResult>;
export type ProcessGroup = (commands: readonly DrawCommand[]) => Promise<DrawResult[]>;

export interface GroupCommitOptions {
  /** Largest group sent in one transaction. */
  max_group: number;
  /**
   * Called once per transaction attempt, for logs and metrics. wait_ms: how long the oldest
   * command of the group waited in this instance for the previous transaction to finish.
   */
  onGroup?: (event: { size: number; outcome: GroupOutcome; wait_ms: number }) => void;
  /**
   * Errors that end a group without replaying its commands one by one: contention that
   * survived every attempt. Default: the retryable transaction codes (retry.ts).
   */
  isContention?: (error: unknown) => boolean;
  /** Clock in milliseconds, for tests. */
  now?: () => number;
}

/**
 * split: the group failed on contention and is retried once as two halves, each one then
 * reported with its own outcome. contention: every command of the group (or of a half) is
 * refused and redelivered later by Pub/Sub.
 */
export type GroupOutcome = 'single' | 'committed' | 'fallback' | 'split' | 'contention';

interface Waiting {
  command: DrawCommand;
  queued_at: number;
  resolve: (result: DrawResult) => void;
  reject: (error: unknown) => void;
}

/**
 * Opportunistic group commit (ADR-0014, option A of 26/11): one transaction at a time per
 * instance. A command that finds the instance idle starts at once and alone, with the
 * unchanged single-command transaction: no added wait. Commands that arrive while a
 * transaction runs form the next group, so groups grow with the load.
 *
 * If a group fails on a data error, each of its commands is processed alone: a faulty command
 * (corrupt tile, reused event id, budget) then fails only its own request, which Pub/Sub
 * retries on its own. If it fails on contention (aborted on every attempt), its commands are
 * NOT replayed one by one, which would collide on the same tiles again and hold the instance
 * for minutes (dev, 27/11 18:38 UTC: 267 s of wait). The group is retried once as two
 * halves instead, one after the other: a smaller transaction commits sooner, so it collides
 * less (dev, 28/11 15:10: 9 groups of 128 refused, 1,152 pixels redelivered). At most three
 * transactions for one group; a half that fails on contention again is refused at once, and
 * Pub/Sub redelivers it later, spread out by its backoff. Every promise settles only after the
 * transaction that holds its pixel.
 */
export function createGroupCommit(processOne: ProcessOne, processGroup: ProcessGroup, options: GroupCommitOptions): ProcessOne {
  if (!Number.isSafeInteger(options.max_group) || options.max_group < 1) throw new Error('max_group must be a positive safe integer');
  const queue: Waiting[] = [];
  const now = options.now ?? (() => performance.now());
  let running = false;
  const isContention = options.isContention ?? isRetryableTransactionError;
  const notify = (size: number, outcome: GroupOutcome, wait_ms: number) => {
    try { options.onGroup?.({ size, outcome, wait_ms }); } catch { /* Observability never fails a draw. */ }
  };
  const alone = async (item: Waiting) => {
    try { item.resolve(await processOne(item.command)); } catch (error) { item.reject(error); }
  };

  const commit = async (group: Waiting[], wait: number, splittable: boolean): Promise<void> => {
    if (group.length === 1) { notify(1, 'single', wait); await alone(group[0]); return; }
    let results: DrawResult[] | undefined;
    let contention: unknown;
    try {
      results = await processGroup(group.map((item) => item.command));
      if (results.length !== group.length) throw new Error('Draw group returned a wrong number of results');
    } catch (error) {
      results = undefined;
      if (isContention(error)) contention = error;
    }
    if (contention !== undefined && splittable) {
      notify(group.length, 'split', wait);
      const middle = Math.ceil(group.length / 2);
      await commit(group.slice(0, middle), wait, false);
      await commit(group.slice(middle), wait, false);
    } else if (contention !== undefined) {
      notify(group.length, 'contention', wait);
      for (const item of group) item.reject(contention);
    } else if (results) {
      notify(group.length, 'committed', wait);
      group.forEach((item, index) => item.resolve(results![index]));
    } else {
      notify(group.length, 'fallback', wait);
      // One after the other: in parallel they would contend on the same documents again.
      for (const item of group) await alone(item);
    }
  };

  const drain = async () => {
    running = true;
    try {
      while (queue.length) {
        const group = queue.splice(0, options.max_group);
        const wait = Math.max(0, Math.round(now() - group[0].queued_at));
        await commit(group, wait, true);
      }
    } finally {
      running = false;
    }
  };

  return (command) => new Promise<DrawResult>((resolve, reject) => {
    queue.push({ command, queued_at: now(), resolve, reject });
    if (!running) void drain();
  });
}
