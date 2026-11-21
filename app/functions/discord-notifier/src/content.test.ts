import { expect, it } from 'vitest';
import { originalResponseContent } from './content';

it('formats processed counts without claiming ignored pixels were drawn', () => {
  expect(originalResponseContent({ type: 'pixel-processed', applied_pixels: 0, ignored_pixels: 1 })).toEqual({
    content: 'Dessin enregistré. Pixels appliqués : 0 ; ignorés : 1.',
    allowed_mentions: { parse: [] }, embeds: [], components: [],
  });
});
it.each([
  ['paused', 'pause'], ['rate_limit', 'Quota'], ['out_of_bounds', 'Coordonnées'],
  ['expired', 'ancienne'], ['batch_budget_exceeded', 'limites'],
] as const)('formats a deterministic safe refusal for %s', (reason, expected) => {
  const result = { type: 'pixel-rejected' as const, applied_pixels: 0, ignored_pixels: 0, reason };
  const content = originalResponseContent(result);
  expect(content.content).toContain(expected);
  expect(content.allowed_mentions.parse).toEqual([]);
  expect(originalResponseContent(result)).toEqual(content);
});
