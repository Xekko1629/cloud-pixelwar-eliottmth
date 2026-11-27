import { Firestore } from '@google-cloud/firestore';
import {
  createDrawProcessor, createGroupCommit, createGroupDrawProcessor, type DrawCommand, type DrawResult, type GroupTiming,
} from '@pixelwar/shared/drawing';

export type ProcessDraw = (command: DrawCommand) => Promise<DrawResult>;

/**
 * Same value as the Cloud Run concurrency of the draw-worker (infra/serverless/draw-path.tf):
 * an instance never holds more requests than that, so a larger group could not form.
 * 128 pixels leave room for their tiles, deltas and users in the 450-document budget of a
 * transaction; a group above it falls back to one transaction per pixel (DrawGroupTooLargeError).
 * 32 (until 27/11) meant about 300 transactions for 5 000 pixels of one user, each one
 * colliding on users/{uid}: 4 times fewer with 128.
 */
export const MAX_DRAW_GROUP = 128;

/** Group commit of ADR-0014: concurrent pushes of one instance share one Firestore transaction. */
export function createLazyDrawProcessor(projectId: string, write?: (line: string) => void): ProcessDraw {
  let process: ProcessDraw | undefined;
  return async (command) => {
    if (!process) {
      const db = new Firestore({ projectId });
      // One transaction at a time per instance: the last timing is the one of the group just notified.
      let timing: GroupTiming | undefined;
      process = createGroupCommit(createDrawProcessor(db), createGroupDrawProcessor(db, {}, (value) => { timing = value; }), {
        max_group: MAX_DRAW_GROUP,
        // One line per transaction (not per pixel): group size, wait and Firestore time are what DRAW-05 shows.
        onGroup: ({ size, outcome, wait_ms }) => {
          if (outcome === 'single') return;
          write?.(`${JSON.stringify({
            severity: outcome === 'fallback' ? 'WARNING' : 'INFO', function: 'draw-worker',
            event_type: outcome === 'fallback' ? 'draw.group.fallback' : 'draw.group.committed', group_size: size,
            wait_ms, ...timing,
          })}\n`);
          timing = undefined;
        },
      });
    }
    return process(command);
  };
}
