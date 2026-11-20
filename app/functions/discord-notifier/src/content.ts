import type { RejectReason, ResultSummary } from './message';

const refusals: Record<RejectReason, string> = {
  paused: 'Le dessin est en pause. Aucun pixel de cette demande n’a été dessiné.',
  rate_limit: 'Quota dépassé. Aucun pixel de cette demande n’a été dessiné.',
  out_of_bounds: 'Coordonnées hors de la grille. Aucun pixel de cette demande n’a été dessiné.',
  expired: 'Cette demande est trop ancienne et n’a pas été dessinée.',
  batch_budget_exceeded: 'Ce lot dépasse les limites de traitement. Aucun pixel de cette demande n’a été dessiné.',
};
export function originalResponseContent(result: ResultSummary) {
  return {
    content: result.type === 'pixel-processed'
      ? `Dessin enregistré. Pixels appliqués : ${result.applied_pixels} ; ignorés : ${result.ignored_pixels}.`
      : refusals[result.reason],
    allowed_mentions: { parse: [] as string[] }, embeds: [], components: [],
  };
}
