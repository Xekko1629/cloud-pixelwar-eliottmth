import { Firestore } from '@google-cloud/firestore';
import {
  createDrawProcessor, createGroupCommit, createGroupDrawProcessor, type DrawCommand, type DrawResult, type GroupTiming,
} from '@pixelwar/shared/drawing';

export type ProcessDraw = (command: DrawCommand) => Promise<DrawResult>;

/**
 * A quarter of the Cloud Run concurrency of the draw-worker (512, infra/serverless/draw-path.tf):
 * the pushes above it wait in the instance for the next group instead of getting a 429.
 * 128 pixels leave room for their tiles, deltas and users in the 450-document budget of a
 * transaction; a group above it falls back to one transaction per pixel (DrawGroupTooLargeError).
 * 32 (until 27/11) meant about 300 transactions for 5 000 pixels of one user, each one
 * colliding on users/{uid}: 4 times fewer with 128.
 */
export const MAX_DRAW_GROUP = 128;

/**
 * ADR-0017: web-proxy reserved the quota of every web pixel before publishing it (only it may
 * publish web pixels on pixel-draw). The worker counts the quota of Discord pixels only.
 */
export const DRAW_OPTIONS = { reserved_sources: ['web'] } as const;

/** Group commit of ADR-0014: concurrent pushes of one instance share one Firestore transaction. */
export function createLazyDrawProcessor(projectId: string, write?: (line: string) => void): ProcessDraw {
  let process: ProcessDraw | undefined;
  return async (command) => {
    if (!process) {
      const db = new Firestore({ projectId });
      // One transaction at a time per instance: the last timing is the one of the group just notified.
      let timing: GroupTiming | undefined;
      process = createGroupCommit(createDrawProcessor(db, DRAW_OPTIONS), createGroupDrawProcessor(db, DRAW_OPTIONS, (value) => { timing = value; }), {
        max_group: MAX_DRAW_GROUP,
        // One line per transaction (not per pixel): group size, wait and Firestore time are what DRAW-05 shows.
        onGroup: ({ size, outcome, wait_ms }) => {
          if (outcome === 'single') return;
          write?.(`${JSON.stringify({
            severity: outcome === 'committed' ? 'INFO' : 'WARNING', function: 'draw-worker',
            event_type: `draw.group.${outcome}`, group_size: size,
            wait_ms, ...timing,
          })}\n`);
          timing = undefined;
        },
      });
    }
    return process(command);
  };
}
