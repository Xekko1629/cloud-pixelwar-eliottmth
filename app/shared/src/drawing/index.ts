// Node-only boundary. Do not export the Firestore adapter through ./grid.
export { createDrawProcessor, processAndPublishDraw } from './transaction';
export {
  DrawProcessingError, MAX_DRAW_AGE_MS, RESULT_RETENTION_MS, MAX_FUTURE_SKEW_MS,
  type DrawCommand, type DrawResult, type DrawOptions,
} from './command';
