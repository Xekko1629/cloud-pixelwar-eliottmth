import { Firestore } from '@google-cloud/firestore';
import { createDrawProcessor, type DrawCommand, type DrawResult } from '@pixelwar/shared/drawing';

export type ProcessDraw = (command: DrawCommand) => Promise<DrawResult>;
export function createLazyDrawProcessor(projectId: string): ProcessDraw {
  let process: ProcessDraw | undefined;
  return async (command) => {
    process ??= createDrawProcessor(new Firestore({ projectId }));
    return process(command);
  };
}
