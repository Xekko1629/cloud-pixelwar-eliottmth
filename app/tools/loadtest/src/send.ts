import { DEFAULT_MAX_BATCH_PIXELS, type DrawPixel } from '@pixelwar/shared/grid';

// Throughput measurement of the draw path (docs/draw-throughput.md): strokes sent through
// the gateway like the browser does, then compared with the draw-worker logs (report.ts).

export const MAX_STROKES = 10;
const ROW = 100;      // Pixels per row of a stroke.
const SPACING = 10;   // Rows between two strokes, so that strokes never overlap.

export interface SendSettings {
  baseUrl: string;
  token: string;
  strokes: number;
  pixels: number;
  x: number;
  y: number;
}

export interface StrokeOutcome {
  index: number;
  status: number;
  sent_at: string;
  duration_ms: number;
  correlation_id?: string;
  event_ids: string[];
  error?: string;
}

/** Saved by `loadtest send`, read by `loadtest report`. Never contains the session token. */
export interface RunRecord {
  schema_version: 1;
  started_at: string;
  finished_at: string;
  strokes: number;
  pixels_per_stroke: number;
  origin: { x: number; y: number };
  results: StrokeOutcome[];
}

/** Unique coordinates inside a stroke (the web-proxy refuses duplicates), rows of 100 pixels. */
export function strokePixels(index: number, count: number, x: number, y: number): DrawPixel[] {
  return Array.from({ length: count }, (_, i) => ({
    x: x + (i % ROW),
    y: y + index * SPACING + Math.floor(i / ROW),
    color: 1 + ((index + i) % 16),
  }));
}

export function validateSettings(settings: SendSettings): void {
  const url = URL.canParse(settings.baseUrl) ? new URL(settings.baseUrl) : null;
  if (!url || url.protocol !== 'https:') throw new Error('PIXELWAR_GATEWAY_URL must be an https URL.');
  if (!settings.token) throw new Error('PIXELWAR_SESSION_TOKEN is missing.');
  if (!Number.isSafeInteger(settings.strokes) || settings.strokes < 1 || settings.strokes > MAX_STROKES) {
    throw new Error(`--strokes must be between 1 and ${MAX_STROKES}.`);
  }
  if (!Number.isSafeInteger(settings.pixels) || settings.pixels < 1 || settings.pixels > DEFAULT_MAX_BATCH_PIXELS) {
    throw new Error(`--pixels must be between 1 and ${DEFAULT_MAX_BATCH_PIXELS}.`);
  }
  if (!Number.isSafeInteger(settings.x) || !Number.isSafeInteger(settings.y)) throw new Error('--x and --y must be integers.');
}

const errorCode = (body: unknown): string => {
  const code = typeof body === 'object' && body !== null ? (body as { error?: unknown }).error : undefined;
  // Only a short fixed code is kept: never a raw body that could echo a header.
  return typeof code === 'string' && /^[a-z_]{1,40}$/.test(code) ? code : 'unexpected_response';
};

/** Sends every stroke at the same time, as several browsers would. */
export async function sendStrokes(
  settings: SendSettings, fetchImpl: typeof fetch = fetch, now: () => number = Date.now,
): Promise<RunRecord> {
  validateSettings(settings);
  const url = `${settings.baseUrl.replace(/\/+$/, '')}/api/pixels`;
  const started = now();
  const results = await Promise.all(Array.from({ length: settings.strokes }, async (_, index): Promise<StrokeOutcome> => {
    const sent = now();
    const outcome = { index, sent_at: new Date(sent).toISOString(), event_ids: [] as string[] };
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${settings.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ pixels: strokePixels(index, settings.pixels, settings.x, settings.y) }),
      });
      const body: unknown = await response.json().catch(() => null);
      const duration = now() - sent;
      if (response.status !== 202) return { ...outcome, status: response.status, duration_ms: duration, error: errorCode(body) };
      const accepted = body as { correlation_id?: unknown; event_ids?: unknown };
      const ids = Array.isArray(accepted?.event_ids) ? accepted.event_ids.filter((id): id is string => typeof id === 'string') : [];
      return {
        ...outcome, status: 202, duration_ms: duration, event_ids: ids,
        ...(typeof accepted?.correlation_id === 'string' ? { correlation_id: accepted.correlation_id } : {}),
      };
    } catch {
      return { ...outcome, status: 0, duration_ms: now() - sent, error: 'network_error' };
    }
  }));
  return {
    schema_version: 1, started_at: new Date(started).toISOString(), finished_at: new Date(now()).toISOString(),
    strokes: settings.strokes, pixels_per_stroke: settings.pixels, origin: { x: settings.x, y: settings.y }, results,
  };
}
