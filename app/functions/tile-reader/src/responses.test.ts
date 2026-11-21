import { describe, expect, it } from 'vitest';
import { TILE_PIXELS, decodeRegionTiles, type GlobalConfigDocument } from '@pixelwar/shared/grid';
import { InvalidRoute, etagOf, iso, matchesEtag, metaBody, parseRoute, regionBody, stateBody } from './responses';

const config: GlobalConfigDocument = { paused: false, canvas_version: 3, size: null, bounds: null, default_limit_per_minute: 20 };
const at = (ms: number) => ({ seconds: Math.floor(ms / 1000), nanoseconds: (ms % 1000) * 1_000_000 });
const NOW = Date.parse('2026-11-20T10:01:05.000Z');

describe('parseRoute', () => {
  it('recognizes the three read routes', () => {
    expect(parseRoute('/api/state')).toEqual({ kind: 'state' });
    expect(parseRoute('/api/regions/-1/0/tiles')).toEqual({ kind: 'tiles', rx: -1, ry: 0, region: '-1_0' });
    expect(parseRoute('/api/tiles/2/-15625000/meta')).toEqual({ kind: 'meta', tx: 2, ty: -15625000 });
  });

  it.each(['/api/state/', '/api/regions/1/2', '/api/regions/01/2/tiles', '/api/regions/-0/2/tiles',
    '/api/regions/+1/2/tiles', '/api/regions/1e3/2/tiles', '/api/tiles/a/1/meta', '/api/pixels', '/'])(
    'treats %s as an unknown path', (path) => { expect(parseRoute(path)).toBeUndefined(); });

  it.each(['/api/regions/976563/0/tiles', '/api/tiles/0/15625001/meta', '/api/regions/9999999999/0/tiles'])(
    'refuses coordinates outside the grid for %s', (path) => { expect(() => parseRoute(path)).toThrow(InvalidRoute); });
});

describe('response bodies', () => {
  it('encodes the region tiles with the shared codec', () => {
    const colors = new Uint8Array(TILE_PIXELS); colors[5] = 9;
    const body = regionBody(3, { kind: 'tiles', rx: 0, ry: -1, region: '0_-1' }, [{ tx: 1, ty: -16, colors }]);
    const decoded = decodeRegionTiles(body, 0, -1);
    expect(decoded).toMatchObject({ canvas_version: 3, tiles: [{ tx: 1, ty: -16 }] });
    expect(decoded.tiles[0].colors[5]).toBe(9);
  });

  it('exposes only the author name and date of each pixel, in index order', () => {
    const body = metaBody(3, { kind: 'meta', tx: 0, ty: 0 }, {
      129: { name: 'Eliott', at: at(Date.parse('2026-11-20T09:00:00.250Z')) },
      7: { name: 'Benjamin', at: at(Date.parse('2026-11-20T08:00:00.000Z')) },
    });
    expect(JSON.parse(body.toString())).toEqual({
      canvas_version: 3, tx: 0, ty: 0, tile_side: 64, pixels: {
        7: { name: 'Benjamin', at: '2026-11-20T08:00:00.000Z' },
        129: { name: 'Eliott', at: '2026-11-20T09:00:00.250Z' },
      },
    });
    expect(Object.keys(JSON.parse(body.toString()).pixels)).toEqual(['7', '129']);
  });

  it('computes the effective quota like DATA-02, with the override and the current minute', () => {
    const usage = { window_start: at(Date.parse('2026-11-20T10:01:00.000Z')), used_pixels: 15, limit_per_minute: 50,
      last_rejection: { event_id: '11111111-1111-4111-8111-111111111111', reason: 'paused', at: at(NOW - 2000) },
      updated_at: at(NOW - 2000) };
    const state = JSON.parse(stateBody({ ...config, paused: true, size: { width: 10_000, height: 20_000 } },
      { usage, override: { limit_per_minute: 50, updated_at: at(0) } }, NOW).toString());
    expect(state).toEqual({
      canvas_version: 3, paused: true, size: { width: 10_000, height: 20_000 }, bounds: null, region_side: 1024,
      user: { limit_per_minute: 50, used_pixels: 15, remaining_pixels: 35, reset_at: '2026-11-20T10:02:00.000Z',
        last_rejection: { event_id: '11111111-1111-4111-8111-111111111111', reason: 'paused', at: '2026-11-20T10:01:03.000Z' } },
    });
  });

  it('resets the usage of a previous minute and handles a user who never drew', () => {
    const usage = { window_start: at(Date.parse('2026-11-20T10:00:00.000Z')), used_pixels: 20, limit_per_minute: 20,
      last_rejection: null, updated_at: at(Date.parse('2026-11-20T10:00:30.000Z')) };
    expect(JSON.parse(stateBody(config, { usage, override: null }, NOW).toString()).user)
      .toMatchObject({ used_pixels: 0, remaining_pixels: 20, last_rejection: null });
    expect(JSON.parse(stateBody(config, { usage: null, override: null }, NOW).toString()).user)
      .toMatchObject({ limit_per_minute: 20, used_pixels: 0, remaining_pixels: 20 });
  });

  it('never reports a negative remaining quota after an admin lowered the limit', () => {
    const usage = { window_start: at(Date.parse('2026-11-20T10:01:00.000Z')), used_pixels: 15, limit_per_minute: 20,
      last_rejection: null, updated_at: at(NOW - 1000) };
    expect(JSON.parse(stateBody(config, { usage, override: { limit_per_minute: 5, updated_at: at(0) } }, NOW).toString()).user)
      .toMatchObject({ limit_per_minute: 5, remaining_pixels: 0 });
  });

  it('refuses a corrupt quota document instead of inventing a value', () => {
    const usage = { window_start: at(NOW + 120_000), used_pixels: 1, limit_per_minute: 20, last_rejection: null, updated_at: at(NOW) };
    expect(() => stateBody(config, { usage, override: null }, NOW)).toThrow();
  });

  it('formats Firestore timestamps with milliseconds', () => {
    expect(iso({ seconds: 1, nanoseconds: 999_999_999 })).toBe('1970-01-01T00:00:01.999Z');
  });
});

describe('ETag', () => {
  it('changes with the body and matches the browser revalidation forms', () => {
    const etag = etagOf(Buffer.from('a'));
    expect(etag).toMatch(/^W\/"[A-Za-z0-9_-]{27}"$/);
    expect(etagOf(Buffer.from('b'))).not.toBe(etag);
    expect(matchesEtag(etag, etag)).toBe(true);
    expect(matchesEtag(etag.slice(2), etag)).toBe(true);
    expect(matchesEtag(`W/"other", ${etag}`, etag)).toBe(true);
    expect(matchesEtag('*', etag)).toBe(true);
    expect(matchesEtag('W/"other"', etag)).toBe(false);
    expect(matchesEtag(undefined, etag)).toBe(false);
  });
});
