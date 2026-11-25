import { useEffect, useRef } from 'react';
import type { CanvasUpdates } from '../realtime/live';
import { pixelAt, visiblePixels, type Viewport } from './camera';
import { CanvasController } from './controller';
import { drawViewport } from './renderer';
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
// changes something, in the next animation frame: no render loop and no polling.
export function PixelCanvas({ live }: { live: CanvasUpdates }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const statusRef = useRef<HTMLOutputElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const status = statusRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !status || !context) return undefined;

    const images = new TileImageCache(live.source, createTileImage);
    let viewport: Viewport = { width: canvas.clientWidth, height: canvas.clientHeight };
    let pixelRatio = window.devicePixelRatio || 1;
    let frame = 0;
    let hovered: { x: number; y: number } | null = null;

    const showStatus = () => {
      const camera = controller.current;
      const position = hovered ?? { x: Math.floor(camera.x), y: Math.floor(camera.y) };
      status.textContent = `x ${position.x} · y ${position.y} · zoom ×${formatZoom(camera.zoom)}`;
    };
    const render = () => {
      frame = 0;
      drawViewport(context, controller.current, viewport, pixelRatio, (tx, ty) => images.get(tx, ty));
      showStatus();
      // The deltas listener follows the visible regions (it ignores an unchanged set).
      live.viewportChanged(visiblePixels(controller.current, viewport));
    };
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(render);
    };
    const controller = new CanvasController(() => viewport, schedule);
    // A delta repaints only the tiles it touches; a new canvas version repaints everything.
    const unsubscribe = live.subscribe((change) => {
      if (change === 'all') images.clear();
      else for (const { tx, ty } of change) images.invalidate(tx, ty);
      schedule();
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
    const onPointerUp = (event: PointerEvent) => controller.pointerUp(event.pointerId);
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
      if (controller.key(event.key)) event.preventDefault();
    };

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerUp);
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
      canvas.removeEventListener('pointercancel', onPointerUp);
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
        aria-label="Grille de pixels. Glisser pour se déplacer, molette ou pincement pour zoomer, flèches et +/− au clavier, 0 pour revenir à l'origine."
      />
      <output ref={statusRef} className="pixel-canvas__status" aria-live="off" />
    </div>
  );
}
