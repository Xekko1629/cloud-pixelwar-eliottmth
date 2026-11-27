import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { ApiClient } from '../api/client';
import { fetchOverviewUrl } from '../api/grid';
import { Brush } from '../brush/brush';
import { PreviewLayer } from '../brush/preview';
import { OverviewImages, type OverviewLoader } from '../canvas/overview';
import { PixelCanvas, type CanvasTool, type StrokeHandlers } from '../canvas/PixelCanvas';
import type { LiveCanvas } from '../realtime/live';
import { PixelInspector, remainingPixels } from './inspector';
import { PixelPanel } from './PixelPanel';

// Far view (WEB-03d): a signed URL from tile-reader, then the image straight from Cloud
// Storage. An empty area has no image: the URL answers 404 and the area stays white.
export function overviewLoader(api: ApiClient, image: () => HTMLImageElement = () => new Image()): OverviewLoader {
  return async (level, cx, cy) => {
    const { url } = await fetchOverviewUrl(api, level, cx, cy);
    return new Promise((resolve) => {
      const element = image();
      element.decoding = 'async';
      element.onload = () => resolve(element);
      element.onerror = () => resolve(null);
      element.src = url;
    });
  };
}

// Whether the preview layer is shown, remembered per browser; on unless turned off.
const PREVIEW_KEY = 'pixelwar.preview';

export function readPreviewSetting(storage: () => Pick<Storage, 'getItem'> = () => window.localStorage): boolean {
  try {
    return storage().getItem(PREVIEW_KEY) !== 'off';
  } catch {
    return true;
  }
}

export function writePreviewSetting(on: boolean, storage: () => Pick<Storage, 'setItem'> = () => window.localStorage): void {
  try {
    storage().setItem(PREVIEW_KEY, on ? 'on' : 'off');
  } catch {
    // Storage blocked: the choice lasts until the page is reloaded.
  }
}

// The canvas and its side panel, for a signed-in user: inspection of a pixel (WEB-04) and
// the brush (WEB-05) share the palette and the quota. What was just sent shows at once
// on a preview layer over the canvas, until its delta arrives; the panel can turn it off.
export function Workspace({ api, live }: { api: ApiClient; live: LiveCanvas }) {
  const [preview] = useState(() => new PreviewLayer());
  const [overview] = useState(() => new OverviewImages(overviewLoader(api)));
  const [previewOn, setPreviewOn] = useState(() => readPreviewSetting());
  const [inspector] = useState(() => new PixelInspector(api, live, {
    preview: (pixels) => preview.add(pixels),
    forget: (pixels) => preview.forget(pixels),
  }));
  const [brush] = useState(() => new Brush(api, {
    color: () => inspector.getState().brushColor,
    config: () => live.getState().config,
    remaining: () => {
      const quota = inspector.getState().quota;
      return quota ? remainingPixels(quota, Date.now()) : null;
    },
    reloadQuota: () => inspector.reloadQuota(),
    recheckQuota: () => inspector.recheckQuota(),
    preview: (pixels) => preview.add(pixels),
    forget: (pixels) => preview.forget(pixels),
    consume: (count) => inspector.consume(count),
  }));
  const [tool, setTool] = useState<CanvasTool>('inspect');
  const { selected } = useSyncExternalStore(inspector.subscribe, inspector.getState);
  const { config } = useSyncExternalStore(live.subscribeState, live.getState);

  useEffect(() => {
    inspector.start();
    return () => inspector.stop();
  }, [inspector]);

  // Back on the tab: the quota may have changed meanwhile (a new minute, /admin ratelimit).
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') void inspector.recheckQuota();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, [inspector]);

  useEffect(() => {
    preview.setEnabled(previewOn);
    writePreviewSetting(previewOn);
  }, [preview, previewOn]);

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
        grid={config?.size ?? null}
        overview={overview}
        bounds={config?.bounds ?? null}
        onSelect={(pixel) => inspector.select(pixel)}
      />
      <PixelPanel
        inspector={inspector}
        brush={brush}
        tool={tool}
        onTool={chooseTool}
        previewOn={previewOn}
        onPreview={setPreviewOn}
      />
    </div>
  );
}
