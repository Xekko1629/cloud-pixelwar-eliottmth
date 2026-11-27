import { COORDINATE_LIMIT, TILE_SIDE } from '@pixelwar/shared/grid';
import { describe, expect, it } from 'vitest';
import { BACKGROUND, GRID_ZOOM, OUTSIDE, drawLayer, drawOverview, drawTiles, drawViewport, type DrawContext } from './renderer';

interface DrawCall { tile: string; x: number; y: number; width: number; height: number }

// Records what the renderer asks of the 2D context.
function recordingContext() {
  const draws: DrawCall[] = [];
  const fills: { style: unknown; rect: number[] }[] = [];
  const lines: number[][] = [];
  const clips: number[][] = [];
  let depth = 0;
  const context: DrawContext & { transform?: number[] } = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    imageSmoothingEnabled: true,
    setTransform(...matrix) { context.transform = matrix; },
    fillRect(...rect) { fills.push({ style: context.fillStyle, rect }); },
    clearRect(...rect) { fills.push({ style: 'clear', rect }); },
    drawImage(image, x, y, width, height) {
      draws.push({ tile: (image as unknown as { id: string }).id, x, y, width, height });
    },
    beginPath() {},
    moveTo(x, y) { lines.push([x, y]); },
    lineTo() {},
    stroke() {},
    save() { depth += 1; },
    restore() { depth -= 1; },
    rect(...rect) { clips.push(rect); },
    clip() {},
  };
  return { context, draws, fills, lines, clips, depth: () => depth };
}

const image = (tx: number, ty: number) => ({ id: `${tx},${ty}` }) as unknown as CanvasImageSource;
const everyTile = (tx: number, ty: number) => image(tx, ty);
const viewport = { width: 800, height: 600 };

describe('drawOverview', () => {
  it('draws the images of the level in view, then the recent pixels on top', () => {
    const { context, draws, fills } = recordingContext();
    // Zoom 1/4: level 1 cells of 1024 pixels are 256 CSS pixels wide.
    const stats = drawOverview(context, { x: 0, y: 0, zoom: 1 / 4 }, viewport, 1, 1,
      (level, cx, cy) => (cx === 0 && cy === 0 ? image(cx, cy) : null), [{ x: 4, y: 8, color: 2 }]);
    expect(stats).toEqual({ tiles: 4 * 4, drawn: 1 });
    expect(draws).toEqual([{ tile: '0,0', x: 400, y: 300, width: 256, height: 256 }]);
    // One CSS pixel at least for a grid pixel.
    expect(fills.at(-1)).toEqual({ style: '#E4E4E4', rect: [401, 302, 1, 1] });
  });
});

describe('edge of a bounded grid', () => {
  it('greys what lies outside the grid and outlines it', () => {
    const { context, fills, clips } = recordingContext();
    // Centre (0, 0) at zoom 4: the grid (0, 0)..(50, 25) starts at the screen centre.
    drawViewport(context, { x: 0, y: 0, zoom: 4 }, viewport, 1, () => null, { width: 50, height: 25 });
    const grey = fills.filter((fill) => fill.style === OUTSIDE).map((fill) => fill.rect);
    expect(grey).toEqual([[0, 0, 800, 300], [0, 400, 800, 200], [0, 300, 400, 100], [600, 300, 200, 100]]);
    expect(clips).toContainEqual([400, 300, 200, 100]);
  });

  it('draws nothing more on an infinite grid', () => {
    const { context, fills } = recordingContext();
    drawViewport(context, { x: 0, y: 0, zoom: 4 }, viewport, 1, () => null, null);
    expect(fills.some((fill) => fill.style === OUTSIDE)).toBe(false);
  });

  it('keeps the outer part of a redrawn tile grey', () => {
    const { context, fills } = recordingContext();
    drawTiles(context, { x: 0, y: 0, zoom: 4 }, viewport, 1, [{ tx: 0, ty: 0 }], () => null, { width: 50, height: 25 });
    expect(fills.some((fill) => fill.style === OUTSIDE)).toBe(true);
  });

  it('keeps the edge positions near the viewport far from the origin', () => {
    const { context, fills } = recordingContext();
    drawViewport(context, { x: 5, y: 5, zoom: 64 }, viewport, 1, () => null, { width: 1_000_000_000, height: 1_000_000_000 });
    for (const { rect } of fills.filter((fill) => fill.style === OUTSIDE)) {
      expect(rect.every((value) => Math.abs(value) <= 801)).toBe(true);
    }
  });
});

describe('drawViewport', () => {
  it('clears to white and disables smoothing at the device pixel ratio', () => {
    const { context, fills } = recordingContext();

    drawViewport(context, { x: 0, y: 0, zoom: 4 }, viewport, 2, () => null);

    expect(context.transform).toEqual([2, 0, 0, 2, 0, 0]);
    expect(context.imageSmoothingEnabled).toBe(false);
    expect(fills).toEqual([{ style: BACKGROUND, rect: [0, 0, 800, 600] }]);
  });

  it('draws only the visible tiles, at their screen position', () => {
    const { context, draws } = recordingContext();

    // 800×600 at zoom 4 = 200×150 grid pixels, from (-100, -75) to (100, 75).
    const stats = drawViewport(context, { x: 0, y: 0, zoom: 4 }, viewport, 1, everyTile);

    expect(stats).toEqual({ tiles: 4 * 4, drawn: 16 });
    expect(new Set(draws.map((d) => d.tile))).toEqual(new Set(
      [-2, -1, 0, 1].flatMap((ty) => [-2, -1, 0, 1].map((tx) => `${tx},${ty}`)),
    ));
    expect(draws.find((d) => d.tile === '0,0')).toEqual({ tile: '0,0', x: 400, y: 300, width: 256, height: 256 });
  });

  it('skips empty tiles, which stay white', () => {
    const { context, draws } = recordingContext();

    const stats = drawViewport(context, { x: 0, y: 0, zoom: 4 }, viewport, 1, (tx, ty) => (tx === 0 && ty === 0 ? image(0, 0) : null));

    expect(stats).toEqual({ tiles: 16, drawn: 1 });
    expect(draws).toHaveLength(1);
  });

  it('places tiles edge to edge at fractional zooms, on device pixels', () => {
    const { context, draws } = recordingContext();

    drawViewport(context, { x: 10.3, y: -7.9, zoom: 1.37 }, viewport, 1.5, everyTile);

    const row = draws.filter((d) => d.y === draws[0].y).sort((a, b) => a.x - b.x);
    for (let i = 1; i < row.length; i += 1) expect(row[i].x).toBeCloseTo(row[i - 1].x + row[i - 1].width, 9);
    for (const draw of draws) expect(Math.abs(draw.x * 1.5 - Math.round(draw.x * 1.5))).toBeLessThan(1e-9);
  });

  it('renders near 10⁹ exactly like near the origin', () => {
    const offset = Math.floor((COORDINATE_LIMIT - 1000) / TILE_SIDE) * TILE_SIDE;
    const near = recordingContext();
    const far = recordingContext();

    drawViewport(near.context, { x: 20.5, y: 33.25, zoom: 3 }, viewport, 1, everyTile);
    drawViewport(far.context, { x: offset + 20.5, y: offset + 33.25, zoom: 3 }, viewport, 1, everyTile);

    const shift = offset / TILE_SIDE;
    const positions = (draws: DrawCall[], dx: number) => draws.map(({ tile, ...rest }) => {
      const [tx, ty] = tile.split(',').map(Number);
      return { tile: `${tx - dx},${ty - dx}`, ...rest };
    });
    expect(positions(far.draws, shift)).toEqual(positions(near.draws, 0));
    // Screen coordinates stay small: absolute coordinates never reach the canvas.
    for (const draw of far.draws) expect(Math.abs(draw.x)).toBeLessThan(1000);
  });

  it('draws the pixel grid from the grid zoom on', () => {
    const below = recordingContext();
    const above = recordingContext();

    drawViewport(below.context, { x: 0, y: 0, zoom: GRID_ZOOM - 1 }, viewport, 1, () => null);
    drawViewport(above.context, { x: 0, y: 0, zoom: 16 }, viewport, 2, () => null);

    expect(below.lines).toEqual([]);
    // 800 / 16 = 50 columns and 600 / 16 = 38 rows (37.5 rounded up), plus their closing border.
    expect(above.lines).toHaveLength(51 + 39);
    expect(above.context.lineWidth).toBe(0.5);
  });
});

describe('drawTiles', () => {
  const camera = { x: 0, y: 0, zoom: 4 };

  it('redraws only the given visible tiles, exactly where drawViewport puts them', () => {
    const full = recordingContext();
    drawViewport(full.context, camera, viewport, 1, everyTile);
    const partial = recordingContext();

    const drawn = drawTiles(partial.context, camera, viewport, 1, [{ tx: 0, ty: 0 }, { tx: 50, ty: 0 }], everyTile);

    expect(drawn).toBe(1);
    const expected = full.draws.find((d) => d.tile === '0,0')!;
    expect(partial.draws).toEqual([expected]);
    expect(partial.clips).toEqual([[expected.x, expected.y, expected.width, expected.height]]);
    expect(partial.fills).toEqual([{ style: BACKGROUND, rect: [expected.x, expected.y, expected.width, expected.height] }]);
    expect(partial.depth()).toBe(0);
  });

  it('clears a tile that became empty', () => {
    const { context, draws, fills } = recordingContext();
    drawTiles(context, camera, viewport, 2, [{ tx: -1, ty: -1 }], () => null);
    expect(draws).toEqual([]);
    expect(fills).toHaveLength(1);
    expect(context.transform).toEqual([2, 0, 0, 2, 0, 0]);
  });

  it('draws the grid of the tile only, at the zoom of the grid', () => {
    const { context, lines } = recordingContext();
    drawTiles(context, { x: 32, y: 32, zoom: GRID_ZOOM }, viewport, 1, [{ tx: 0, ty: 0 }], everyTile);
    // 800 / 12 ≈ 67 visible columns, 600 / 12 = 50 rows: the tile holds all the rows
    // and 64 + 1 vertical lines are at most needed.
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.length).toBeLessThanOrEqual(65 + 65);
  });
});

describe('drawLayer', () => {
  it('clears the layer, then draws only its visible tiles, where the canvas puts them', () => {
    const full = recordingContext();
    drawViewport(full.context, { x: 0, y: 0, zoom: 4 }, viewport, 1, everyTile);
    const layer = recordingContext();

    const drawn = drawLayer(layer.context, { x: 0, y: 0, zoom: 4 }, viewport, 1, [{ tx: 0, ty: 0 }, { tx: 99, ty: 0 }], everyTile);

    expect(drawn).toBe(1);
    expect(layer.fills).toEqual([{ style: 'clear', rect: [0, 0, 800, 600] }]);
    expect(layer.draws).toEqual([full.draws.find((d) => d.tile === '0,0')]);
  });
});
