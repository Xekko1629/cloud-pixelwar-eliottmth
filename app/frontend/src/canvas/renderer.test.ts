import { COORDINATE_LIMIT, TILE_SIDE } from '@pixelwar/shared/grid';
import { describe, expect, it } from 'vitest';
import { BACKGROUND, GRID_ZOOM, drawViewport, type DrawContext } from './renderer';

interface DrawCall { tile: string; x: number; y: number; width: number; height: number }

// Records what the renderer asks of the 2D context.
function recordingContext() {
  const draws: DrawCall[] = [];
  const fills: { style: unknown; rect: number[] }[] = [];
  const lines: number[][] = [];
  const context: DrawContext & { transform?: number[] } = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    imageSmoothingEnabled: true,
    setTransform(...matrix) { context.transform = matrix; },
    fillRect(...rect) { fills.push({ style: context.fillStyle, rect }); },
    drawImage(image, x, y, width, height) {
      draws.push({ tile: (image as unknown as { id: string }).id, x, y, width, height });
    },
    beginPath() {},
    moveTo(x, y) { lines.push([x, y]); },
    lineTo() {},
    stroke() {},
  };
  return { context, draws, fills, lines };
}

const image = (tx: number, ty: number) => ({ id: `${tx},${ty}` }) as unknown as CanvasImageSource;
const everyTile = (tx: number, ty: number) => image(tx, ty);
const viewport = { width: 800, height: 600 };

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
