import { TILE_SIDE } from '@pixelwar/shared/grid';
import { screenX, screenY, visiblePixels, visibleTiles, type Camera, type Viewport } from './camera';

// The subset of CanvasRenderingContext2D the renderer uses, so tests can record the calls.
export interface DrawContext {
  fillStyle: string | CanvasGradient | CanvasPattern;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  imageSmoothingEnabled: boolean;
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;
  fillRect(x: number, y: number, width: number, height: number): void;
  drawImage(image: CanvasImageSource, dx: number, dy: number, dw: number, dh: number): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  stroke(): void;
}

// Image of a painted tile, or null for a tile with nothing painted (left white).
export type TileImageLookup = (tx: number, ty: number) => CanvasImageSource | null;

export const BACKGROUND = '#FFFFFF';
// Pixel borders appear from this zoom on (CSS pixels per grid pixel).
export const GRID_ZOOM = 12;
const GRID_COLOR = 'rgba(0, 0, 0, 0.08)';

export interface FrameStats {
  tiles: number;
  drawn: number;
}

// Rounds a CSS coordinate to the device pixel grid: adjacent tiles share the same edge,
// so neither seams nor overlaps appear between them at fractional zooms.
const snap = (value: number, ratio: number) => Math.round(value * ratio) / ratio;

export function drawViewport(
  context: DrawContext,
  camera: Camera,
  viewport: Viewport,
  pixelRatio: number,
  tileImage: TileImageLookup,
): FrameStats {
  context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  context.imageSmoothingEnabled = false;
  context.fillStyle = BACKGROUND;
  context.fillRect(0, 0, viewport.width, viewport.height);

  const tiles = visibleTiles(camera, viewport);
  const stats = { tiles: 0, drawn: 0 };
  for (let ty = tiles.min_y; ty <= tiles.max_y; ty += 1) {
    const top = snap(screenY(camera, viewport, ty * TILE_SIDE), pixelRatio);
    const bottom = snap(screenY(camera, viewport, (ty + 1) * TILE_SIDE), pixelRatio);
    for (let tx = tiles.min_x; tx <= tiles.max_x; tx += 1) {
      stats.tiles += 1;
      const image = tileImage(tx, ty);
      if (image === null) continue;
      const left = snap(screenX(camera, viewport, tx * TILE_SIDE), pixelRatio);
      const right = snap(screenX(camera, viewport, (tx + 1) * TILE_SIDE), pixelRatio);
      context.drawImage(image, left, top, right - left, bottom - top);
      stats.drawn += 1;
    }
  }

  if (camera.zoom >= GRID_ZOOM) drawGrid(context, camera, viewport, pixelRatio);
  return stats;
}

function drawGrid(context: DrawContext, camera: Camera, viewport: Viewport, pixelRatio: number): void {
  const pixels = visiblePixels(camera, viewport);
  context.strokeStyle = GRID_COLOR;
  context.lineWidth = 1 / pixelRatio;
  context.beginPath();
  // A half device pixel offset keeps one-device-pixel lines sharp.
  const offset = 0.5 / pixelRatio;
  for (let x = pixels.min_x; x <= pixels.max_x + 1; x += 1) {
    const sx = snap(screenX(camera, viewport, x), pixelRatio) + offset;
    context.moveTo(sx, 0);
    context.lineTo(sx, viewport.height);
  }
  for (let y = pixels.min_y; y <= pixels.max_y + 1; y += 1) {
    const sy = snap(screenY(camera, viewport, y), pixelRatio) + offset;
    context.moveTo(0, sy);
    context.lineTo(viewport.width, sy);
  }
  context.stroke();
}
