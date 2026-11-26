import { useEffect, useState, useSyncExternalStore } from 'react';
import type { ApiClient } from '../api/client';
import { PixelCanvas } from '../canvas/PixelCanvas';
import type { LiveCanvas } from '../realtime/live';
import { PixelInspector } from './inspector';
import { PixelPanel } from './PixelPanel';

// The canvas and the panel of the selected pixel, for a signed-in user (WEB-04).
export function Workspace({ api, live }: { api: ApiClient; live: LiveCanvas }) {
  const [inspector] = useState(() => new PixelInspector(api, live));
  const { selected } = useSyncExternalStore(inspector.subscribe, inspector.getState);

  useEffect(() => {
    inspector.start();
    return () => inspector.stop();
  }, [inspector]);

  return (
    <div className="workspace">
      <PixelCanvas live={live} selected={selected} onSelect={(pixel) => inspector.select(pixel)} />
      <PixelPanel inspector={inspector} />
    </div>
  );
}
