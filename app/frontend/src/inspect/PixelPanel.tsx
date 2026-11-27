import { PALETTE } from '@pixelwar/shared/grid';
import { useEffect, useState, useSyncExternalStore } from 'react';
import type { Brush, StrokeStatus } from '../brush/brush';
import { MAX_BRUSH_SIZE, MIN_BRUSH_SIZE } from '../brush/stroke';
import type { CanvasTool } from '../canvas/PixelCanvas';
import { remainingPixels, type DrawBlock, type DrawFeedback, type PixelInspector } from './inspector';

// Side panel (WEB-04, WEB-05): tool, quota, palette, then the selected pixel (author,
// date, "Poser") or the brush (size, shape, result of the last stroke).

const REJECTIONS: Record<string, string> = {
  paused: 'la toile est en pause',
  rate_limit: 'quota de pixels dépassé',
  out_of_bounds: 'hors de la grille',
  expired: 'la demande a expiré',
  batch_budget_exceeded: 'trop de pixels d’un coup',
};

const ERRORS: Record<string, string> = {
  publish_unavailable: 'envoi incertain, une partie a peut-être été dessinée. Vérifie avant de réessayer.',
  too_many_requests: 'trop de requêtes, réessaie dans un instant.',
};

const BLOCKS: Partial<Record<DrawBlock, string>> = {
  paused: 'La toile est en pause.',
  outside: 'Ce pixel est hors de la grille.',
  quota: 'Quota atteint : un nouvel essai revérifie auprès du serveur.',
};

export const dateFormat = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'short', timeStyle: 'medium' });
const timeFormat = new Intl.DateTimeFormat('fr-FR', { timeStyle: 'medium' });
const reason = (code: string) => REJECTIONS[code] ?? code;
const error = (code: string) => ERRORS[code] ?? `échec de l’envoi (${code}).`;

export function feedbackText(feedback: DrawFeedback): string | null {
  switch (feedback.status) {
    case 'sending': return 'Envoi…';
    case 'waiting': return 'Envoyé, en cours de traitement…';
    case 'drawn': return 'Pixel posé.';
    case 'pending': return 'Envoyé, pas encore visible sur la toile.';
    case 'rejected': return `Refusé : ${reason(feedback.reason)}.`;
    case 'error': return `Échec : ${error(feedback.code)}`;
    default: return null;
  }
}

/** One message per stroke, refusals grouped. */
export function strokeText(stroke: StrokeStatus): string | null {
  switch (stroke.status) {
    case 'drawing':
    case 'sending': return `Trait : ${stroke.covered} pixels, ${stroke.sent} envoyés…`;
    case 'done': return `Trait envoyé : ${stroke.sent} pixels.${stroke.limited ? ' Arrêté au quota restant.' : ''}`;
    case 'rejected': return `Trait envoyé : ${stroke.sent} pixels, une partie refusée : ${reason(stroke.reason)}.`;
    case 'error': return `Trait interrompu après ${stroke.sent} pixels : ${error(stroke.code)}`;
    default: return null;
  }
}

interface PanelProps {
  inspector: PixelInspector;
  brush: Brush;
  tool: CanvasTool;
  onTool: (tool: CanvasTool) => void;
  previewOn: boolean;
  onPreview: (on: boolean) => void;
}

export function PixelPanel({ inspector, brush, tool, onTool, previewOn, onPreview }: PanelProps) {
  const state = useSyncExternalStore(inspector.subscribe, inspector.getState);
  const brushState = useSyncExternalStore(brush.subscribe, brush.getState);
  // Re-evaluated on each render; the inspector re-renders at the end of the quota minute.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => setNow(Date.now()), [state, brushState]);

  const { selected, quota } = state;
  const remaining = quota ? remainingPixels(quota, now) : null;

  return (
    <aside className="pixel-panel" aria-label="Outils">
      <div className="pixel-panel__tools" role="radiogroup" aria-label="Outil">
        {(['inspect', 'brush'] as const).map((value) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={tool === value}
            className="auth__button pixel-panel__tool"
            onClick={() => onTool(value)}
          >
            {value === 'inspect' ? 'Inspecter' : 'Pinceau'}
          </button>
        ))}
      </div>
      {quota && remaining !== null && (
        <p className="pixel-panel__quota">
          Pixels restants : {remaining} / {quota.limitPerMinute}
          {remaining === 0 && ` (de nouveau à ${timeFormat.format(quota.resetAt)})`}
        </p>
      )}
      <div className="pixel-panel__palette" role="radiogroup" aria-label="Couleur">
        {PALETTE.map((hex, i) => (
          <button
            key={hex}
            type="button"
            role="radio"
            aria-checked={state.brushColor === i + 1}
            aria-label={`Couleur ${i + 1}`}
            className="pixel-panel__color"
            style={{ background: hex }}
            onClick={() => inspector.setBrushColor(i + 1)}
          />
        ))}
      </div>
      <label className="pixel-panel__option">
        <input type="checkbox" checked={previewOn} onChange={(event) => onPreview(event.target.checked)} />
        Aperçu de l’envoi (calque semi-transparent)
      </label>
      {tool === 'brush' ? <BrushControls brush={brush} /> : selected === null ? (
        <p className="pixel-panel__hint">Clique sur un pixel pour voir son auteur et le dessiner.</p>
      ) : (
        <SelectedPixel inspector={inspector} />
      )}
      {tool === 'inspect' && feedbackText(state.feedback) && (
        <p className="pixel-panel__feedback" role="status">{feedbackText(state.feedback)}</p>
      )}
    </aside>
  );
}

function SelectedPixel({ inspector }: { inspector: PixelInspector }) {
  const state = useSyncExternalStore(inspector.subscribe, inspector.getState);
  const block = inspector.drawBlock();
  const selected = state.selected!;
  return (
    <>
      <p className="pixel-panel__coords">
        <span className="pixel-panel__swatch" style={{ background: state.color ? PALETTE[state.color - 1] : 'transparent' }} />
        x {selected.x} · y {selected.y}
      </p>
      <p className="pixel-panel__author" aria-live="polite">
        {state.meta === 'loading' ? 'Chargement de l’auteur…'
          : state.meta === 'error' ? 'Auteur indisponible.'
            : state.author ? `Par ${state.author.name}, le ${dateFormat.format(state.author.at)}.`
              : 'Jamais peint.'}
      </p>
      <button
        type="button"
        className="auth__button pixel-panel__draw"
        // Out of quota, a click asks the server again (the limit may have changed).
        disabled={block !== null && block !== 'quota'}
        onClick={() => void inspector.draw()}
      >
        Poser le pixel
      </button>
      {block && BLOCKS[block] && <p className="pixel-panel__block">{BLOCKS[block]}</p>}
    </>
  );
}

function BrushControls({ brush }: { brush: Brush }) {
  const state = useSyncExternalStore(brush.subscribe, brush.getState);
  const block = brush.block();
  const message = strokeText(state.stroke);
  return (
    <>
      <label className="pixel-panel__size">
        Taille : {state.size} × {state.size}
        <input
          type="range"
          min={MIN_BRUSH_SIZE}
          max={MAX_BRUSH_SIZE}
          value={state.size}
          onChange={(event) => brush.setSize(Number(event.target.value))}
        />
      </label>
      <div className="pixel-panel__tools" role="radiogroup" aria-label="Forme">
        {(['square', 'round'] as const).map((shape) => (
          <button
            key={shape}
            type="button"
            role="radio"
            aria-checked={state.shape === shape}
            className="auth__button pixel-panel__tool"
            onClick={() => brush.setShape(shape)}
          >
            {shape === 'square' ? 'Carré' : 'Rond'}
          </button>
        ))}
      </div>
      <p className="pixel-panel__hint">
        Glisse sur la toile pour peindre. Clic droit, molette enfoncée ou deux doigts pour te déplacer.
      </p>
      {block && <p className="pixel-panel__block">{block === 'paused' ? 'La toile est en pause.' : 'Quota atteint : un nouvel essai revérifie auprès du serveur.'}</p>}
      {message && <p className="pixel-panel__feedback" role="status">{message}</p>}
    </>
  );
}
