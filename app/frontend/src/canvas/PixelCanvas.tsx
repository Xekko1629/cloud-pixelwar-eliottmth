import { useEffect, useRef } from 'react';
import type { Bounds, GridSize } from '@pixelwar/shared/grid';
import type { CanvasUpdates, TileChange } from '../realtime/live';
import { fitCamera, pixelAt, screenX, screenY, visiblePixels, type Camera, type Point, type Viewport } from './camera';
import { FrameIcon } from '../ui/icons';
import { CanvasController } from './controller';
import { FAR_ZOOM, RecentPixels, overviewLevel, visibleCells, type OverviewImages } from './overview';
import { drawLayer, drawOverview, drawTiles, drawViewport, type TileRef } from './renderer';
import { TileImageCache, type TileColorsSource } from './tiles';

// One 64×64 canvas per painted tile, drawn scaled with drawImage: never a DOM element per pixel.
function createTileImage(rgba: Uint8ClampedArray<ArrayBuffer>): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  canvas.getContext('2d')?.putImageData(new ImageData(rgba, 64, 64), 0, 0);
  return canvas;
}

const formatZoom = (zoom: number) =>
  (zoom >= 10 ? zoom.toFixed(0) : zoom >= 1 ? zoom.toFixed(1) : `1/${Math.round(1 / zoom)}`);

// Full-size canvas of the grid. Redraws only when the camera, the size or a realtime delta
// changes something, in the next animation frame: no render loop and no polling. Deltas
// received in the same frame are drawn together, and only their tiles are redrawn while
// the camera stays still (WEB-03c).
export interface StrokeHandlers {
  begin(pixel: Point | null): void;
  extend(pixel: Point | null): void;
  end(): void;
}

export type CanvasTool = 'inspect' | 'brush';

/** A transparent layer over the canvas: the preview of what was just sent (WEB-05). */
export interface CanvasLayer extends TileColorsSource {
  keys(): TileRef[];
  subscribe(listener: (change: TileChange) => void): () => void;
}

export interface PixelCanvasProps {
  live: CanvasUpdates;
  // inspect: a tap selects a pixel. brush: the main button or one finger paints (WEB-05);
  // the other mouse buttons, two fingers and the keyboard still move the camera.
  tool?: CanvasTool;
  stroke?: StrokeHandlers;
  preview?: CanvasLayer;
  // The selected pixel, outlined on the canvas (WEB-04).
  selected?: Point | null;
  // Size of a bounded grid (config/global, DRAW-04): edge drawn, camera kept on it.
  grid?: GridSize | null;
  // Images of the far view (WEB-03d), shown below zoom 1.
  overview?: OverviewImages;
  // Painted area (config/global.bounds): the "voir tout le dessin" button frames it.
  bounds?: Bounds | null;
  // A tap, Enter (centre pixel) or Escape (null).
  onSelect?: (pixel: Point | null) => void;
}

export function PixelCanvas({
  live, tool = 'inspect', stroke, preview, selected = null, grid = null, overview, bounds = null, onSelect,
}: PixelCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const layerRef = useRef<HTMLCanvasElement>(null);
  const statusRef = useRef<HTMLOutputElement>(null);
  const markerRef = useRef<HTMLDivElement>(null);
  // Read by the effect without restarting it (it owns the listeners and the camera).
  const selectedRef = useRef(selected);
  const onSelectRef = useRef(onSelect);
  const placeMarkerRef = useRef<() => void>(() => {});
  onSelectRef.current = onSelect;
  const toolRef = useRef(tool);
  toolRef.current = tool;
  const strokeRef = useRef(stroke);
  strokeRef.current = stroke;
  const gridRef = useRef(grid);
  const applyGridRef = useRef<() => void>(() => {});
  const boundsRef = useRef(bounds);
  boundsRef.current = bounds;
  const fitRef = useRef<() => void>(() => {});

  useEffect(() => {
    selectedRef.current = selected;
    placeMarkerRef.current();
  }, [selected]);

  useEffect(() => {
    gridRef.current = grid;
    applyGridRef.current();
  }, [grid?.width, grid?.height]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const status = statusRef.current;
    const marker = markerRef.current;
    const context = canvas?.getContext('2d');
    const layer = layerRef.current;
    const layerContext = layer?.getContext('2d');
    if (!canvas || !status || !marker || !context || !layer || !layerContext) return undefined;

    const images = new TileImageCache(live.source, createTileImage);
    const layerImages = preview ? new TileImageCache(preview, createTileImage, 2048, 'transparent') : null;
    let layerDirty = true;
    let viewport: Viewport = { width: canvas.clientWidth, height: canvas.clientHeight };
    let pixelRatio = window.devicePixelRatio || 1;
    let frame = 0;
    let hovered: { x: number; y: number } | null = null;
    // Pointer that paints the current brush stroke.
    let painting: number | null = null;
    // What the next frame must redraw: everything, or only these tiles.
    let dirty: Map<string, TileRef> | 'all' = 'all';
    // Realtime pixels the far view paints over its images, which lag behind (WEB-03d).
    const recent = new RecentPixels();
    const isFar = () => overview !== undefined && controller.current.zoom < FAR_ZOOM;

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
      if (preview && layerImages && (layerDirty || redraw === 'all')) {
        layerDirty = false;
        drawLayer(layerContext, controller.current, viewport, pixelRatio, preview.keys(), (tx, ty) => layerImages.get(tx, ty));
      }
      if (isFar()) {
        // Far view: images of the pyramid level that suits the zoom, redrawn as a whole.
        const camera = controller.current;
        const level = overviewLevel(camera.zoom);
        overview!.show(level, visibleCells(camera, viewport, level));
        const pixels = recent.inside(visiblePixels(camera, viewport));
        drawOverview(context, camera, viewport, pixelRatio, level, (l, cx, cy) => overview!.get(l, cx, cy), pixels, gridRef.current);
        placeMarker();
        showStatus();
        // No region is loaded; the deltas listener follows every region past 30.
        live.viewportChanged(visiblePixels(camera, viewport), true);
      } else if (redraw === 'all') {
        drawViewport(context, controller.current, viewport, pixelRatio, lookup, gridRef.current);
        placeMarker();
        showStatus();
        // The deltas listener follows the visible regions (it ignores an unchanged set).
        live.viewportChanged(visiblePixels(controller.current, viewport));
      } else {
        drawTiles(context, controller.current, viewport, pixelRatio, redraw.values(), lookup, gridRef.current);
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
    // The size comes from config/global: the camera is brought back on the grid, the edge redrawn.
    applyGridRef.current = () => {
      controller.setGrid(gridRef.current ?? null);
      schedule();
    };
    applyGridRef.current();
    fitRef.current = () => {
      if (boundsRef.current) controller.moveTo(fitCamera(boundsRef.current, viewport));
    };
    // A delta repaints only the tiles it touches; a new canvas version repaints everything.
    const unsubscribe = live.subscribe((change) => {
      if (change === 'all') {
        images.clear();
        overview?.clear();
        recent.clear();
        schedule();
        return;
      }
      if (isFar()) {
        for (const tile of change) images.invalidate(tile.tx, tile.ty);
        schedule();
        return;
      }
      for (const tile of change) {
        images.invalidate(tile.tx, tile.ty);
        if (dirty !== 'all') dirty.set(`${tile.tx},${tile.ty}`, tile);
      }
      request();
    });
    const unsubscribePixels = live.subscribePixels?.((pixels) => recent.add(pixels, Date.now()));
    // A new image shows the realtime pixels older than it: they are no longer painted over it.
    const unsubscribeOverview = overview?.subscribe((area, askedAt) => {
      recent.covered(area, askedAt);
      if (isFar()) schedule();
    });
    // The preview only redraws its own layer.
    const unsubscribeLayer = preview?.subscribe((change) => {
      if (change === 'all') layerImages?.clear();
      else for (const { tx, ty } of change) layerImages?.invalidate(tx, ty);
      layerDirty = true;
      request();
    });

    const resize = () => {
      pixelRatio = window.devicePixelRatio || 1;
      viewport = { width: canvas.clientWidth, height: canvas.clientHeight };
      canvas.width = layer.width = Math.round(viewport.width * pixelRatio);
      canvas.height = layer.height = Math.round(viewport.height * pixelRatio);
      schedule();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    resize();

    const local = (event: PointerEvent | WheelEvent) => {
      const rect = canvas.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };
    const endStroke = () => {
      if (painting === null) return;
      painting = null;
      strokeRef.current?.end();
    };
    const onPointerDown = (event: PointerEvent) => {
      canvas.setPointerCapture(event.pointerId);
      const paints = toolRef.current === 'brush' && strokeRef.current && painting === null && !controller.dragging &&
        (event.pointerType !== 'mouse' || event.button === 0);
      if (paints) {
        painting = event.pointerId;
        strokeRef.current!.begin(pixelAt(controller.current, viewport, local(event)));
        return;
      }
      // A second finger turns the stroke into a pan or a pinch.
      if (painting !== null && event.pointerType === 'touch') endStroke();
      controller.pointerDown(event.pointerId, local(event));
    };
    const onPointerMove = (event: PointerEvent) => {
      const point = local(event);
      hovered = pixelAt(controller.current, viewport, point);
      if (event.pointerId === painting) {
        // Coalesced events keep a fast stroke precise; the stroke fills the gaps anyway.
        const events = event.getCoalescedEvents?.() ?? [];
        for (const sample of events.length > 0 ? events : [event]) {
          strokeRef.current?.extend(pixelAt(controller.current, viewport, local(sample)));
        }
      } else {
        controller.pointerMove(event.pointerId, point);
      }
      showStatus();
    };
    const onPointerUp = (event: PointerEvent) => {
      if (event.pointerId === painting) return endStroke();
      const tap = controller.pointerUp(event.pointerId);
      if (tap && toolRef.current === 'inspect') onSelectRef.current?.(pixelAt(controller.current, viewport, tap));
    };
    const onPointerCancel = (event: PointerEvent) => {
      if (event.pointerId === painting) return endStroke();
      controller.pointerCancel(event.pointerId);
    };
    // The right button pans in brush mode: no context menu on the grid.
    const onContextMenu = (event: MouseEvent) => {
      if (toolRef.current === 'brush') event.preventDefault();
    };
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
    canvas.addEventListener('contextmenu', onContextMenu);
    canvas.addEventListener('keydown', onKeyDown);
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      unsubscribe();
      unsubscribeLayer?.();
      unsubscribePixels?.();
      unsubscribeOverview?.();
      fitRef.current = () => {};
      observer.disconnect();
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerCancel);
      placeMarkerRef.current = () => {};
      canvas.removeEventListener('pointerleave', onPointerLeave);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('contextmenu', onContextMenu);
      endStroke();
      canvas.removeEventListener('keydown', onKeyDown);
    };
  }, [live, preview, overview]);

  return (
    <div className="pixel-canvas">
      <canvas
        ref={canvasRef}
        className="pixel-canvas__surface"
        data-tool={tool}
        tabIndex={0}
        aria-label="Grille de pixels. Glisser pour se déplacer, molette ou pincement pour zoomer, flèches et +/− au clavier, 0 pour revenir à l'origine. Cliquer, ou Entrée au centre, pour sélectionner un pixel ; Échap pour désélectionner. En mode pinceau, glisser pour peindre ; clic droit, molette enfoncée ou deux doigts pour se déplacer."
      />
      <canvas ref={layerRef} className="pixel-canvas__layer" aria-hidden="true" />
      <div ref={markerRef} className="pixel-canvas__marker" hidden aria-hidden="true" />
      <output ref={statusRef} className="pixel-canvas__status" aria-live="off" />
      {bounds && (
        <button
          type="button"
          className="pill pixel-canvas__fit"
          onClick={() => fitRef.current()}
          title="Cadrer toute la zone dessinée"
        >
          <FrameIcon width={16} height={16} />
          Tout le dessin
        </button>
      )}
    </div>
  );
}
