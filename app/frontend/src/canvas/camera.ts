import { COORDINATE_LIMIT, TILE_SIDE, type GridSize } from '@pixelwar/shared/grid';

// The camera looks at the infinite grid (ADR-0007). (x, y) is the world point at the centre
// of the screen, in grid pixels; pixel (px, py) covers [px, px + 1) × [py, py + 1).
// zoom is the number of CSS pixels per grid pixel.
//
// Every screen position is computed relative to the camera, in float64: near 10⁹ a float32
// (WebGL, and the Canvas 2D backends) has a precision of 64 grid pixels, so absolute
// coordinates never reach the drawing API.
export interface Camera {
  x: number;
  y: number;
  zoom: number;
}

export interface Viewport {
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface PixelRect {
  min_x: number;
  min_y: number;
  max_x: number;
  max_y: number;
}

// Below zoom 1 the far view takes over (WEB-03d, canvas/overview.ts). MIN_ZOOM stops at the
// last level of the pyramid, where one image pixel covers 64 × 64 grid pixels: the grid is
// infinite, one moves across it but never sees all of it at once. MAX_ZOOM shows one pixel
// as a large square.
export const MIN_ZOOM = 1 / 64;
export const MAX_ZOOM = 64;
export const DEFAULT_ZOOM = 4;

// The frontend opens on the origin (ADR-0007).
export function initialCamera(): Camera {
  return { x: 0, y: 0, zoom: DEFAULT_ZOOM };
}

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

// The camera stays inside the validated coordinates, ±10⁹ (pixel 10⁹ ends at 10⁹ + 1). On a
// bounded grid (/admin size, DRAW-04), the screen centre stays on (0, 0)..(width, height).
export function clampCamera(camera: Camera, grid: GridSize | null = null): Camera {
  return {
    x: clamp(camera.x, grid ? 0 : -COORDINATE_LIMIT, grid ? grid.width : COORDINATE_LIMIT + 1),
    y: clamp(camera.y, grid ? 0 : -COORDINATE_LIMIT, grid ? grid.height : COORDINATE_LIMIT + 1),
    zoom: clamp(camera.zoom, MIN_ZOOM, MAX_ZOOM),
  };
}

export function screenToWorld(camera: Camera, viewport: Viewport, screen: Point): Point {
  return {
    x: camera.x + (screen.x - viewport.width / 2) / camera.zoom,
    y: camera.y + (screen.y - viewport.height / 2) / camera.zoom,
  };
}

// The subtraction comes first: both terms are large, their difference is small and exact.
export function worldToScreen(camera: Camera, viewport: Viewport, world: Point): Point {
  return {
    x: (world.x - camera.x) * camera.zoom + viewport.width / 2,
    y: (world.y - camera.y) * camera.zoom + viewport.height / 2,
  };
}

// Same as worldToScreen on one axis, for an integer grid coordinate.
export function screenX(camera: Camera, viewport: Viewport, x: number): number {
  return (x - camera.x) * camera.zoom + viewport.width / 2;
}

export function screenY(camera: Camera, viewport: Viewport, y: number): number {
  return (y - camera.y) * camera.zoom + viewport.height / 2;
}

// Moves the world with the pointer: a drag of (dx, dy) CSS pixels.
export function pan(camera: Camera, dx: number, dy: number): Camera {
  return clampCamera({ ...camera, x: camera.x - dx / camera.zoom, y: camera.y - dy / camera.zoom });
}

// Zooms by factor, keeping the world point under the anchor (cursor, pinch centre) in place.
export function zoomAt(camera: Camera, viewport: Viewport, factor: number, anchor: Point): Camera {
  const zoom = clamp(camera.zoom * factor, MIN_ZOOM, MAX_ZOOM);
  const world = screenToWorld(camera, viewport, anchor);
  return clampCamera({
    x: world.x - (anchor.x - viewport.width / 2) / zoom,
    y: world.y - (anchor.y - viewport.height / 2) / zoom,
    zoom,
  });
}

// Camera that shows the whole rectangle, within the zoom limits ("voir tout le dessin").
export function fitCamera(area: PixelRect, viewport: Viewport, maxZoom = DEFAULT_ZOOM): Camera {
  const width = area.max_x - area.min_x + 1;
  const height = area.max_y - area.min_y + 1;
  // A margin of 10 % around the drawing.
  const zoom = Math.min(viewport.width / width, viewport.height / height) * 0.9;
  return clampCamera({
    x: (area.min_x + area.max_x + 1) / 2,
    y: (area.min_y + area.max_y + 1) / 2,
    zoom: Math.min(zoom, maxZoom),
  });
}

// Grid pixel under a screen point, or null outside the validated coordinates.
export function pixelAt(camera: Camera, viewport: Viewport, screen: Point): Point | null {
  const world = screenToWorld(camera, viewport, screen);
  const x = Math.floor(world.x);
  const y = Math.floor(world.y);
  if (Math.abs(x) > COORDINATE_LIMIT || Math.abs(y) > COORDINATE_LIMIT) return null;
  return { x, y };
}

// Inclusive rectangle of the grid pixels at least partly visible, clipped to ±10⁹.
export function visiblePixels(camera: Camera, viewport: Viewport): PixelRect {
  const halfWidth = viewport.width / 2 / camera.zoom;
  const halfHeight = viewport.height / 2 / camera.zoom;
  return {
    min_x: clamp(Math.floor(camera.x - halfWidth), -COORDINATE_LIMIT, COORDINATE_LIMIT),
    min_y: clamp(Math.floor(camera.y - halfHeight), -COORDINATE_LIMIT, COORDINATE_LIMIT),
    max_x: clamp(Math.ceil(camera.x + halfWidth) - 1, -COORDINATE_LIMIT, COORDINATE_LIMIT),
    max_y: clamp(Math.ceil(camera.y + halfHeight) - 1, -COORDINATE_LIMIT, COORDINATE_LIMIT),
  };
}

// Inclusive range of the tiles that hold the visible pixels.
export function visibleTiles(camera: Camera, viewport: Viewport): PixelRect {
  const pixels = visiblePixels(camera, viewport);
  return {
    min_x: Math.floor(pixels.min_x / TILE_SIDE),
    min_y: Math.floor(pixels.min_y / TILE_SIDE),
    max_x: Math.floor(pixels.max_x / TILE_SIDE),
    max_y: Math.floor(pixels.max_y / TILE_SIDE),
  };
}
