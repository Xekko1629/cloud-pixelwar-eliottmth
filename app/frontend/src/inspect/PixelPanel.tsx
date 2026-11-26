import { PALETTE } from '@pixelwar/shared/grid';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { remainingPixels, type DrawBlock, type DrawFeedback, type PixelInspector } from './inspector';

// Side panel of the selected pixel (WEB-04): author and date, palette, "Poser".

const REJECTIONS: Record<string, string> = {
  paused: 'Refusé : la toile est en pause.',
  rate_limit: 'Refusé : quota de pixels dépassé.',
  out_of_bounds: 'Refusé : hors de la grille.',
  expired: 'Refusé : la demande a expiré.',
  batch_budget_exceeded: 'Refusé : trop de pixels d’un coup.',
};

const ERRORS: Record<string, string> = {
  publish_unavailable: 'Envoi incertain : le pixel sera peut-être dessiné. Vérifie avant de réessayer.',
  too_many_requests: 'Trop de requêtes, réessaie dans un instant.',
};

const BLOCKS: Partial<Record<DrawBlock, string>> = {
  paused: 'La toile est en pause.',
  outside: 'Ce pixel est hors de la grille.',
  quota: 'Quota atteint.',
};

export const dateFormat = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'short', timeStyle: 'medium' });
const timeFormat = new Intl.DateTimeFormat('fr-FR', { timeStyle: 'medium' });

export function feedbackText(feedback: DrawFeedback): string | null {
  switch (feedback.status) {
    case 'sending': return 'Envoi…';
    case 'waiting': return 'Envoyé, en cours de traitement…';
    case 'drawn': return 'Pixel posé.';
    case 'pending': return 'Envoyé, pas encore visible sur la toile.';
    case 'rejected': return REJECTIONS[feedback.reason] ?? `Refusé (${feedback.reason}).`;
    case 'error': return ERRORS[feedback.code] ?? `Échec de l’envoi (${feedback.code}).`;
    default: return null;
  }
}

export function PixelPanel({ inspector }: { inspector: PixelInspector }) {
  const state = useSyncExternalStore(inspector.subscribe, inspector.getState);
  // Re-evaluated on each render; the inspector re-renders at the end of the quota minute.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => setNow(Date.now()), [state]);

  const { selected, quota } = state;
  const block = inspector.drawBlock();
  const feedback = feedbackText(state.feedback);

  return (
    <aside className="pixel-panel" aria-label="Pixel sélectionné">
      {quota && (
        <p className="pixel-panel__quota">
          Pixels restants : {remainingPixels(quota, now)} / {quota.limitPerMinute}
          {remainingPixels(quota, now) === 0 && ` (de nouveau à ${timeFormat.format(quota.resetAt)})`}
        </p>
      )}
      {selected === null ? (
        <p className="pixel-panel__hint">Clique sur un pixel pour voir son auteur et le dessiner.</p>
      ) : (
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
          <button
            type="button"
            className="auth__button pixel-panel__draw"
            disabled={block !== null}
            onClick={() => void inspector.draw()}
          >
            Poser le pixel
          </button>
          {block && BLOCKS[block] && <p className="pixel-panel__block">{BLOCKS[block]}</p>}
        </>
      )}
      {feedback && <p className="pixel-panel__feedback" role="status">{feedback}</p>}
    </aside>
  );
}
