import { useEffect, useRef } from 'react';
import type { CanvasUpdates } from '../realtime/live';
import { pixelAt, screenX, screenY, visiblePixels, type Camera, type Point, type Viewport } from './camera';
import { CanvasController } from './controller';
import { drawTiles, drawViewport, type TileRef } from './renderer';
import { TileImageCache } from './tiles';

// One 64×64 canvas per painted tile, drawn scaled with drawImage: never a DOM element per pixel.
function createTileImage(rgba: Uint8ClampedArray<ArrayBuffer>): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  canvas.getContext('2d')?.putImageData(new ImageData(rgba, 64, 64), 0, 0);
  return canvas;
}

const formatZoom = (zoom: number) => (zoom >= 10 ? zoom.toFixed(0) : zoom.toFixed(1));

// Full-size canvas of the grid. Redraws only when the camera, the size or a realtime delta
// changes something, in the next animation frame: no render loop and no polling. Deltas
// received in the same frame are drawn together, and only their tiles are redrawn while
// the camera stays still (WEB-03c).
export interface PixelCanvasProps {
  live: CanvasUpdates;
  // The selected pixel, outlined on the canvas (WEB-04).
  selected?: Point | null;
  // A tap, Enter (centre pixel) or Escape (null).
  onSelect?: (pixel: Point | null) => void;
}

export function PixelCanvas({ live, selected = null, onSelect }: PixelCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const statusRef = useRef<HTMLOutputElement>(null);
  const markerRef = useRef<HTMLDivElement>(null);
  // Read by the effect without restarting it (it owns the listeners and the camera).
  const selectedRef = useRef(selected);
  const onSelectRef = useRef(onSelect);
  const placeMarkerRef = useRef<() => void>(() => {});
  onSelectRef.current = onSelect;

  useEffect(() => {
    selectedRef.current = selected;
    placeMarkerRef.current();
  }, [selected]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const status = statusRef.current;
    const marker = markerRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !status || !marker || !context) return undefined;

    const images = new TileImageCache(live.source, createTileImage);
    let viewport: Viewport = { width: canvas.clientWidth, height: canvas.clientHeight };
    let pixelRatio = window.devicePixelRatio || 1;
    let frame = 0;
    let hovered: { x: number; y: number } | null = null;
    // What the next frame must redraw: everything, or only these tiles.
    let dirty: Map<string, TileRef> | 'all' = 'all';

    const showStatus = () => {
      const camera = controller.current;
      const position = hovered ?? { x: Math.floor(camera.x), y: Math.floor(camera.y) };
      status.textContent = `x ${position.x} · y ${position.y} · zoom ×${formatZoom(camera.zoom)}`;
    };
    // One DOM element over the canvas, moved with the camera: never one per pixel.
    const placeMarker = (camera: Camera = controller.current) => {
      const pixel = selectedRef.current;
      marker.hidden = pixel === null;
      if (pixel === null) return;
      const size = Math.max(camera.zoom, 4);
      const left = screenX(camera, viewport, pixel.x + 0.5) - size / 2;
      const top = screenY(camera, viewport, pixel.y + 0.5) - size / 2;
      marker.style.transform = `translate(${left}px, ${top}px)`;
      marker.style.width = marker.style.height = `${size}px`;
    };
    placeMarkerRef.current = () => placeMarker();
    const render = () => {
      frame = 0;
      const lookup = (tx: number, ty: number) => images.get(tx, ty);
      const redraw = dirty;
      dirty = new Map();
      if (redraw === 'all') {
        drawViewport(context, controller.current, viewport, pixelRatio, lookup);
        placeMarker();
        showStatus();
        // The deltas listener follows the visible regions (it ignores an unchanged set).
        live.viewportChanged(visiblePixels(controller.current, viewport));
      } else {
        drawTiles(context, controller.current, viewport, pixelRatio, redraw.values(), lookup);
      }
    };
    const request = () => {
      if (frame === 0) frame = requestAnimationFrame(render);
    };
    // Camera, size or canvas version: the whole viewport.
    const schedule = () => {
      dirty = 'all';
      request();
    };
    const controller = new CanvasController(() => viewport, schedule);
    // A delta repaints only the tiles it touches; a new canvas version repaints everything.
    const unsubscribe = live.subscribe((change) => {
      if (change === 'all') {
        images.clear();
        schedule();
        return;
      }
      for (const tile of change) {
        images.invalidate(tile.tx, tile.ty);
        if (dirty !== 'all') dirty.set(`${tile.tx},${tile.ty}`, tile);
      }
      request();
    });

    const resize = () => {
      pixelRatio = window.devicePixelRatio || 1;
      viewport = { width: canvas.clientWidth, height: canvas.clientHeight };
      canvas.width = Math.round(viewport.width * pixelRatio);
      canvas.height = Math.round(viewport.height * pixelRatio);
      schedule();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    resize();

    const local = (event: PointerEvent | WheelEvent) => {
      const rect = canvas.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };
    const onPointerDown = (event: PointerEvent) => {
      canvas.setPointerCapture(event.pointerId);
      controller.pointerDown(event.pointerId, local(event));
    };
    const onPointerMove = (event: PointerEvent) => {
      const point = local(event);
      controller.pointerMove(event.pointerId, point);
      hovered = pixelAt(controller.current, viewport, point);
      showStatus();
    };
    const onPointerUp = (event: PointerEvent) => {
      const tap = controller.pointerUp(event.pointerId);
      if (tap) onSelectRef.current?.(pixelAt(controller.current, viewport, tap));
    };
    const onPointerCancel = (event: PointerEvent) => controller.pointerCancel(event.pointerId);
    const onPointerLeave = () => {
      hovered = null;
      showStatus();
    };
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      controller.wheel(event.deltaY, event.deltaMode, local(event));
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === 'Enter' || event.key === 'Escape') {
        const centre = { x: viewport.width / 2, y: viewport.height / 2 };
        onSelectRef.current?.(event.key === 'Enter' ? pixelAt(controller.current, viewport, centre) : null);
        event.preventDefault();
        return;
      }
      if (controller.key(event.key)) event.preventDefault();
    };

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerCancel);
    canvas.addEventListener('pointerleave', onPointerLeave);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('keydown', onKeyDown);
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      unsubscribe();
      observer.disconnect();
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerCancel);
      placeMarkerRef.current = () => {};
      canvas.removeEventListener('pointerleave', onPointerLeave);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('keydown', onKeyDown);
    };
  }, [live]);

  return (
    <div className="pixel-canvas">
      <canvas
        ref={canvasRef}
        className="pixel-canvas__surface"
        tabIndex={0}
        aria-label="Grille de pixels. Glisser pour se déplacer, molette ou pincement pour zoomer, flèches et +/− au clavier, 0 pour revenir à l'origine. Cliquer, ou Entrée au centre, pour sélectionner un pixel ; Échap pour désélectionner."
      />
      <div ref={markerRef} className="pixel-canvas__marker" hidden aria-hidden="true" />
      <output ref={statusRef} className="pixel-canvas__status" aria-live="off" />
    </div>
  );
}
