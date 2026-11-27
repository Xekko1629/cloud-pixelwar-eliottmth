import type { DrawCommand, DrawResult } from './command';

export type ProcessOne = (command: DrawCommand) => Promise<DrawResult>;
export type ProcessGroup = (commands: readonly DrawCommand[]) => Promise<DrawResult[]>;

export interface GroupCommitOptions {
  /** Largest group sent in one transaction. */
  max_group: number;
  /**
   * Called once per transaction attempt, for logs and metrics. wait_ms: how long the oldest
   * command of the group waited in this instance for the previous transaction to finish.
   */
  onGroup?: (event: { size: number; outcome: 'single' | 'committed' | 'fallback'; wait_ms: number }) => void;
  /** Clock in milliseconds, for tests. */
  now?: () => number;
}

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
 * If a group fails, each of its commands is processed alone: a faulty command (corrupt
 * tile, reused event id, budget) then fails only its own request, which Pub/Sub retries
 * on its own. Every promise settles only after the transaction that holds its pixel.
 */
export function createGroupCommit(processOne: ProcessOne, processGroup: ProcessGroup, options: GroupCommitOptions): ProcessOne {
  if (!Number.isSafeInteger(options.max_group) || options.max_group < 1) throw new Error('max_group must be a positive safe integer');
  const queue: Waiting[] = [];
  const now = options.now ?? (() => performance.now());
  let running = false;
  const notify = (size: number, outcome: 'single' | 'committed' | 'fallback', wait_ms: number) => {
    try { options.onGroup?.({ size, outcome, wait_ms }); } catch { /* Observability never fails a draw. */ }
  };
  const alone = async (item: Waiting) => {
    try { item.resolve(await processOne(item.command)); } catch (error) { item.reject(error); }
  };

  const drain = async () => {
    running = true;
    try {
      while (queue.length) {
        const group = queue.splice(0, options.max_group);
        const wait = Math.max(0, Math.round(now() - group[0].queued_at));
        if (group.length === 1) { notify(1, 'single', wait); await alone(group[0]); continue; }
        let results: DrawResult[] | undefined;
        try {
          results = await processGroup(group.map((item) => item.command));
          if (results.length !== group.length) throw new Error('Draw group returned a wrong number of results');
        } catch {
          results = undefined;
        }
        if (results) {
          notify(group.length, 'committed', wait);
          group.forEach((item, index) => item.resolve(results![index]));
        } else {
          notify(group.length, 'fallback', wait);
          // One after the other: in parallel they would contend on the same documents again.
          for (const item of group) await alone(item);
        }
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
