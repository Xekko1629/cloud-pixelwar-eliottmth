import { PALETTE } from '@pixelwar/shared/grid';
import { useEffect, useState, useSyncExternalStore } from 'react';
import type { Brush, StrokeStatus } from '../brush/brush';
import { MAX_BRUSH_SIZE, MIN_BRUSH_SIZE } from '../brush/stroke';
import type { CanvasTool } from '../canvas/PixelCanvas';
import { BrushIcon, CircleIcon, EyeIcon, EyeOffIcon, PointerIcon, SquareIcon } from '../ui/icons';
import { remainingPixels, type DrawBlock, type DrawFeedback, type PixelInspector } from './inspector';

// Controls floating over the canvas (WEB-04, WEB-05): the tools bar on the left, the colour
// dock with the quota at the bottom, and a card for the selected pixel or the brush.

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
  paused: 'Toile en pause',
  outside: 'Hors de la grille',
  quota: 'Quota atteint',
};

export const dateFormat = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
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

// How long the message of an ended action stays: a success briefly, a refusal a bit longer.
const DONE_MS = 4000;
const REFUSED_MS = 8000;

/**
 * Shows a message, and hides it after `ms` when the action it reports is over (null: keep
 * it, the action is still running). A display timer only, nothing is asked to the server.
 */
export function useTransient(text: string | null, ms: number | null, source: object): string | null {
  // `source` is the state the message comes from: a new one shows again, even with the same text.
  const [hidden, setHidden] = useState<object | null>(null);
  useEffect(() => {
    if (text === null || ms === null) return undefined;
    const timer = setTimeout(() => setHidden(source), ms);
    return () => clearTimeout(timer);
  }, [text, ms, source]);
  return hidden === source ? null : text;
}

const feedbackDelay = (status: DrawFeedback['status']): number | null =>
  status === 'drawn' ? DONE_MS : status === 'rejected' || status === 'error' || status === 'pending' ? REFUSED_MS : null;

const strokeDelay = (status: StrokeStatus['status']): number | null =>
  status === 'done' ? DONE_MS : status === 'rejected' || status === 'error' ? REFUSED_MS : null;

interface PanelProps {
  inspector: PixelInspector;
  brush: Brush;
  tool: CanvasTool;
  onTool: (tool: CanvasTool) => void;
  previewOn: boolean;
  onPreview: (on: boolean) => void;
}

const TOOLS = [
  { value: 'inspect', label: 'Inspecter', Icon: PointerIcon },
  { value: 'brush', label: 'Pinceau', Icon: BrushIcon },
] as const;

export function PixelPanel({ inspector, brush, tool, onTool, previewOn, onPreview }: PanelProps) {
  const state = useSyncExternalStore(inspector.subscribe, inspector.getState);
  const brushState = useSyncExternalStore(brush.subscribe, brush.getState);
  // Re-evaluated on each render; the inspector re-renders at the end of the quota minute.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => setNow(Date.now()), [state, brushState]);

  const { selected, quota } = state;
  const remaining = quota ? remainingPixels(quota, now) : null;
  const feedback = useTransient(tool === 'inspect' ? feedbackText(state.feedback) : null, feedbackDelay(state.feedback.status), state.feedback);

  return (
    <>
      <nav className="toolbar" aria-label="Outils">
        <div className="toolbar__group" role="radiogroup" aria-label="Outil">
          {TOOLS.map(({ value, label, Icon }) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={tool === value}
              aria-label={label}
              title={label}
              className="tool"
              onClick={() => onTool(value)}
            >
              <Icon />
            </button>
          ))}
        </div>
        <span className="toolbar__divider" aria-hidden="true" />
        <button
          type="button"
          className="tool"
          aria-pressed={previewOn}
          aria-label="Aperçu de l’envoi"
          title={previewOn ? 'Aperçu de l’envoi : affiché' : 'Aperçu de l’envoi : masqué'}
          onClick={() => onPreview(!previewOn)}
        >
          {previewOn ? <EyeIcon /> : <EyeOffIcon />}
        </button>
      </nav>

      <div className="dock">
        <div className="dock__palette" role="radiogroup" aria-label="Couleur">
          {PALETTE.map((hex, i) => (
            <button
              key={hex}
              type="button"
              role="radio"
              aria-checked={state.brushColor === i + 1}
              aria-label={`Couleur ${i + 1}`}
              className="swatch"
              style={{ background: hex }}
              onClick={() => inspector.setBrushColor(i + 1)}
            />
          ))}
        </div>
        {quota && remaining !== null && (
          <QuotaMeter remaining={remaining} limit={quota.limitPerMinute} resetAt={quota.resetAt} />
        )}
      </div>

      {tool === 'brush' ? <BrushControls brush={brush} /> : selected !== null ? (
        <SelectedPixel inspector={inspector} feedback={feedback} />
      ) : feedback && (
        <p className="toast toast--side" role="status">{feedback}</p>
      )}
    </>
  );
}

/** Seconds left before the quota of the minute is whole again, recomputed every second. */
function useSecondsUntil(at: Date, active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    setNow(Date.now());
    // A local countdown for the display only, no request to the server; it stops at zero.
    const timer = setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (current >= at.getTime()) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  }, [active, at]);
  return Math.max(0, Math.ceil((at.getTime() - now) / 1000));
}

// Pixels left this minute: a ring that empties, the count, the limit, and when it refills.
function QuotaMeter({ remaining, limit, resetAt }: { remaining: number; limit: number; resetAt: Date }) {
  const seconds = useSecondsUntil(resetAt, remaining < limit);
  // The minute is over: the whole limit is back, even before the panel is told.
  const left = seconds === 0 ? limit : remaining;
  const used = left < limit;
  const ratio = Math.min(1, left / Math.max(1, limit));
  const circumference = 2 * Math.PI * 15;
  const state = left === 0 ? 'empty' : ratio <= 0.25 ? 'low' : 'ok';
  const format = (value: number) => value.toLocaleString('fr-FR');
  return (
    <div className="quota" data-state={state} title={`Quota : ${format(limit)} pixels par minute, remis à zéro chaque minute`}>
      <div className="quota__ring" aria-hidden="true">
        <svg viewBox="0 0 36 36" width="42" height="42">
          <circle className="quota__track" cx="18" cy="18" r="15" />
          <circle
            className="quota__fill"
            cx="18"
            cy="18"
            r="15"
            strokeDasharray={circumference}
            strokeDashoffset={circumference * (1 - ratio)}
          />
        </svg>
        <span className="quota__percent">{Math.round(ratio * 100)}%</span>
      </div>
      <div className="quota__text" role="status" aria-live="off">
        <span className="quota__count">
          <strong>{format(left)}</strong> / {format(limit)} pixels
        </span>
        <span className="quota__detail">
          {!used ? 'par minute' : left === 0 ? `épuisé · retour dans ${seconds} s` : `rechargé dans ${seconds} s`}
        </span>
      </div>
    </div>
  );
}

function SelectedPixel({ inspector, feedback }: { inspector: PixelInspector; feedback: string | null }) {
  const state = useSyncExternalStore(inspector.subscribe, inspector.getState);
  const block = inspector.drawBlock();
  const selected = state.selected!;
  return (
    <aside className="card" aria-label="Pixel sélectionné">
      <div className="card__head">
        <span className="card__swatch" style={{ background: state.color ? PALETTE[state.color - 1] : 'transparent' }} />
        <span className="card__coords">{selected.x}, {selected.y}</span>
      </div>
      <p className="card__meta" aria-live="polite">
        {state.meta === 'loading' ? 'Chargement…'
          : state.meta === 'error' ? 'Auteur indisponible'
            : state.author ? <><strong>{state.author.name}</strong> · {dateFormat.format(state.author.at)}</>
              : 'Jamais peint'}
      </p>
      <button
        type="button"
        className="button button--primary card__action"
        // Out of quota, a click asks the server again (the limit may have changed).
        disabled={block !== null && block !== 'quota'}
        onClick={() => void inspector.draw()}
      >
        <span className="card__dot" style={{ background: PALETTE[state.brushColor - 1] }} aria-hidden="true" />
        Poser
      </button>
      {block && BLOCKS[block] && <p className="card__note">{BLOCKS[block]}</p>}
      {feedback && <p className="card__note" role="status">{feedback}</p>}
    </aside>
  );
}

const SHAPES = [
  { value: 'square', label: 'Carré', Icon: SquareIcon },
  { value: 'round', label: 'Rond', Icon: CircleIcon },
] as const;

function BrushControls({ brush }: { brush: Brush }) {
  const state = useSyncExternalStore(brush.subscribe, brush.getState);
  const block = brush.block();
  const message = useTransient(strokeText(state.stroke), strokeDelay(state.stroke.status), state.stroke);
  return (
    <aside className="card" aria-label="Pinceau">
      <label className="card__row" htmlFor="brush-size">
        <span>Taille</span>
        <output className="card__value" htmlFor="brush-size">{state.size} px</output>
      </label>
      <input
        id="brush-size"
        type="range"
        min={MIN_BRUSH_SIZE}
        max={MAX_BRUSH_SIZE}
        value={state.size}
        onChange={(event) => brush.setSize(Number(event.target.value))}
      />
      <div className="segmented" role="radiogroup" aria-label="Forme">
        {SHAPES.map(({ value, label, Icon }) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={state.shape === value}
            aria-label={label}
            title={label}
            className="segmented__item"
            onClick={() => brush.setShape(value)}
          >
            <Icon width={16} height={16} />
          </button>
        ))}
      </div>
      {block && <p className="card__note">{block === 'paused' ? 'Toile en pause' : 'Quota atteint'}</p>}
      {message && <p className="card__note" role="status">{message}</p>}
    </aside>
  );
}
