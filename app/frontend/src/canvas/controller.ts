import { initialCamera, pan, zoomAt, type Camera, type Point, type Viewport } from './camera';

// Turns pointer, wheel and keyboard input into camera moves. Independent of React and
// of the DOM: the component forwards the events in CSS pixels relative to the canvas.

// Wheel: one notch (deltaY ≈ 100) zooms by about 16 %, whatever the zoom level.
const WHEEL_SENSITIVITY = 0.0015;
const LINE_HEIGHT = 16;
const KEY_PAN = 64;
const KEY_ZOOM = 1.25;
// A press that moves less than this (CSS pixels) is a tap: it selects a pixel (WEB-04).
export const TAP_SLOP = 6;

export class CanvasController {
  private camera: Camera;
  private readonly pointers = new Map<number, Point>();
  // The single press that may still become a tap; a second finger or a drag cancels it.
  private tap: { id: number; start: Point; moved: boolean } | null = null;

  constructor(
    private readonly viewport: () => Viewport,
    private readonly onChange: (camera: Camera) => void,
    camera: Camera = initialCamera(),
  ) {
    this.camera = camera;
  }

  get current(): Camera {
    return this.camera;
  }

  get dragging(): boolean {
    return this.pointers.size > 0;
  }

  private set(camera: Camera): void {
    if (camera.x === this.camera.x && camera.y === this.camera.y && camera.zoom === this.camera.zoom) return;
    this.camera = camera;
    this.onChange(camera);
  }

  pointerDown(id: number, point: Point): void {
    // Two fingers at most: a third one is ignored until one is lifted.
    if (this.pointers.size >= 2) return;
    this.tap = this.pointers.size === 0 ? { id, start: point, moved: false } : null;
    this.pointers.set(id, point);
  }

  pointerMove(id: number, point: Point): void {
    const previous = this.pointers.get(id);
    if (!previous) return;
    if (this.tap?.id === id && distance(this.tap.start, point) > TAP_SLOP) this.tap.moved = true;
    if (this.pointers.size === 1) {
      this.pointers.set(id, point);
      this.set(pan(this.camera, point.x - previous.x, point.y - previous.y));
      return;
    }
    // Pinch: the centre moves the world, the distance ratio zooms around the centre.
    const [other] = [...this.pointers].filter(([key]) => key !== id).map(([, value]) => value);
    const before = { centre: midpoint(previous, other), distance: distance(previous, other) };
    const after = { centre: midpoint(point, other), distance: distance(point, other) };
    this.pointers.set(id, point);
    const moved = pan(this.camera, after.centre.x - before.centre.x, after.centre.y - before.centre.y);
    const factor = before.distance > 0 && after.distance > 0 ? after.distance / before.distance : 1;
    this.set(zoomAt(moved, this.viewport(), factor, after.centre));
  }

  /** Returns where the press started when it was a tap, else null. */
  pointerUp(id: number): Point | null {
    this.pointers.delete(id);
    const tap = this.tap;
    if (tap?.id !== id) return null;
    this.tap = null;
    return tap.moved ? null : tap.start;
  }

  /** The press was cancelled by the browser (pointercancel): never a tap. */
  pointerCancel(id: number): void {
    this.pointers.delete(id);
    if (this.tap?.id === id) this.tap = null;
  }

  // deltaMode: 0 = pixels, 1 = lines (Firefox), 2 = pages.
  wheel(deltaY: number, deltaMode: number, anchor: Point): void {
    const pixels = deltaMode === 1 ? deltaY * LINE_HEIGHT : deltaMode === 2 ? deltaY * this.viewport().height : deltaY;
    this.set(zoomAt(this.camera, this.viewport(), Math.exp(-pixels * WHEEL_SENSITIVITY), anchor));
  }

  // Returns true when the key moved the camera, so the caller can prevent the default.
  key(key: string): boolean {
    const viewport = this.viewport();
    const centre = { x: viewport.width / 2, y: viewport.height / 2 };
    const moves: Record<string, () => Camera> = {
      ArrowLeft: () => pan(this.camera, KEY_PAN, 0),
      ArrowRight: () => pan(this.camera, -KEY_PAN, 0),
      ArrowUp: () => pan(this.camera, 0, KEY_PAN),
      ArrowDown: () => pan(this.camera, 0, -KEY_PAN),
      '+': () => zoomAt(this.camera, viewport, KEY_ZOOM, centre),
      '=': () => zoomAt(this.camera, viewport, KEY_ZOOM, centre),
      '-': () => zoomAt(this.camera, viewport, 1 / KEY_ZOOM, centre),
      '0': () => initialCamera(),
    };
    const move = moves[key];
    if (!move) return false;
    this.set(move());
    return true;
  }

  // Moves the camera to a given place, for example a link or "show the whole drawing".
  moveTo(camera: Camera): void {
    this.set(camera);
  }
}

function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
