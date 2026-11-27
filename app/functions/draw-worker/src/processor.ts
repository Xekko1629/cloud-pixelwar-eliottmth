import { Firestore } from '@google-cloud/firestore';
import {
  createDrawProcessor, createGroupCommit, createGroupDrawProcessor, type DrawCommand, type DrawResult, type GroupTiming,
} from '@pixelwar/shared/drawing';

export type ProcessDraw = (command: DrawCommand) => Promise<DrawResult>;

/**
 * Same value as the Cloud Run concurrency of the draw-worker (infra/serverless/draw-path.tf):
 * an instance never holds more requests than that, so a larger group could not form.
 * 32 pixels stay far below the 450-document budget of a transaction.
 */
export const MAX_DRAW_GROUP = 32;

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
