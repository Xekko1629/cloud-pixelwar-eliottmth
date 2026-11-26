import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { ApiClient } from '../api/client';
import { Brush } from '../brush/brush';
import { PreviewLayer } from '../brush/preview';
import { PixelCanvas, type CanvasTool, type StrokeHandlers } from '../canvas/PixelCanvas';
import type { LiveCanvas } from '../realtime/live';
import { PixelInspector, remainingPixels } from './inspector';
import { PixelPanel } from './PixelPanel';

// The canvas and its side panel, for a signed-in user: inspection of a pixel (WEB-04) and
// the brush (WEB-05) share the palette and the quota. What was just sent shows at once
// on a preview layer over the canvas, until its delta arrives.
export function Workspace({ api, live }: { api: ApiClient; live: LiveCanvas }) {
  const [preview] = useState(() => new PreviewLayer());
  const [inspector] = useState(() => new PixelInspector(api, live, { preview: (pixels) => preview.add(pixels) }));
  const [brush] = useState(() => new Brush(api, {
    color: () => inspector.getState().brushColor,
    config: () => live.getState().config,
    remaining: () => {
      const quota = inspector.getState().quota;
      return quota ? remainingPixels(quota, Date.now()) : null;
    },
    reloadQuota: () => inspector.reloadQuota(),
    preview: (pixels) => preview.add(pixels),
  }));
  const [tool, setTool] = useState<CanvasTool>('inspect');
  const { selected } = useSyncExternalStore(inspector.subscribe, inspector.getState);

  useEffect(() => {
    inspector.start();
    return () => inspector.stop();
  }, [inspector]);

  // A preview pixel goes away when the canvas shows its colour (its delta arrived).
  useEffect(() => live.subscribe((change) => preview.settle(change, live.source)), [live, preview]);

  const stroke = useMemo<StrokeHandlers>(() => ({
    begin: (pixel) => brush.begin(pixel),
    extend: (pixel) => brush.extend(pixel),
    end: () => brush.end(),
  }), [brush]);

  const chooseTool = (next: CanvasTool) => {
    setTool(next);
    if (next === 'brush') inspector.select(null);
  };

  return (
    <div className="workspace">
      <PixelCanvas
        live={live}
        tool={tool}
        stroke={stroke}
        preview={preview}
        selected={tool === 'inspect' ? selected : null}
        onSelect={(pixel) => inspector.select(pixel)}
      />
      <PixelPanel inspector={inspector} brush={brush} tool={tool} onTool={chooseTool} />
    </div>
  );
}
