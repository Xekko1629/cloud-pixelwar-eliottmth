import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { ApiClient } from '../api/client';
import { Brush } from '../brush/brush';
import { PixelCanvas, type CanvasTool, type StrokeHandlers } from '../canvas/PixelCanvas';
import type { LiveCanvas } from '../realtime/live';
import { PixelInspector, remainingPixels } from './inspector';
import { PixelPanel } from './PixelPanel';

// The canvas and its side panel, for a signed-in user: inspection of a pixel (WEB-04) and
// the brush (WEB-05) share the palette and the quota.
export function Workspace({ api, live }: { api: ApiClient; live: LiveCanvas }) {
  const [inspector] = useState(() => new PixelInspector(api, live));
  const [brush] = useState(() => new Brush(api, {
    color: () => inspector.getState().brushColor,
    config: () => live.getState().config,
    remaining: () => {
      const quota = inspector.getState().quota;
      return quota ? remainingPixels(quota, Date.now()) : null;
    },
    reloadQuota: () => inspector.reloadQuota(),
  }));
  const [tool, setTool] = useState<CanvasTool>('inspect');
  const { selected } = useSyncExternalStore(inspector.subscribe, inspector.getState);

  useEffect(() => {
    inspector.start();
    return () => inspector.stop();
  }, [inspector]);

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
        selected={tool === 'inspect' ? selected : null}
        onSelect={(pixel) => inspector.select(pixel)}
      />
      <PixelPanel inspector={inspector} brush={brush} tool={tool} onTool={chooseTool} />
    </div>
  );
}
