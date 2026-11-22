import { textResponse, type OriginalResponseBody } from '@pixelwar/shared/discord';
import type { RenderResult } from './render';

const number = (value: number) => value.toLocaleString('fr-FR');
export const IMAGE_FILENAME = 'pixelwar.png';

/** Fixed sentences only: no user-provided text is interpolated, mentions are disabled. */
export function renderResponse(result: RenderResult): OriginalResponseBody {
  switch (result.kind) {
    case 'empty': return textResponse('La toile est vide pour l’instant : dessine le premier pixel avec /draw.');
    case 'too_large': return textResponse('La zone peinte est trop grande pour une image Discord. Utilise le site pour la parcourir, '
      + 'ou demande à un administrateur de borner la grille avec /admin size.');
    case 'image': {
      const { area, scale, width, height } = result.image;
      return textResponse(`Zone peinte de (${number(area.min_x)}, ${number(area.min_y)}) à (${number(area.max_x)}, ${number(area.max_y)}), `
        + `image de ${number(width)} × ${number(height)} px${scale > 1 ? `, 1 pixel pour ${number(scale)} × ${number(scale)} pixels de la grille` : ''}.`);
    }
  }
}
