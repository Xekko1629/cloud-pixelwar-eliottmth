import { textResponse, type OriginalResponseBody } from '@pixelwar/shared/discord';
import type { AdminResult } from './admin';

const number = (value: number) => value.toLocaleString('fr-FR');

/** Fixed sentences only: no user-provided text is interpolated, mentions are disabled. */
export function adminResponse(result: AdminResult | { status: 'unauthorized' }, purge?: 'pending'): OriginalResponseBody {
  if (result.status === 'unauthorized') {
    return textResponse('La commande /admin est réservée aux administrateurs. Aucune action n’a été effectuée.');
  }
  if (result.status === 'rejected') {
    return textResponse('Configuration globale absente : aucune modification n’a été faite. Initialisez config/global avant d’utiliser /admin.');
  }
  switch (result.subcommand) {
    case 'pause': return textResponse('Dessins suspendus, sur Discord comme sur le web.');
    case 'resume': return textResponse('Dessins réactivés.');
    case 'clear': return textResponse(`Grille effacée : version ${number(result.canvas_version)}.${purge === 'pending' ? ' Les anciennes tuiles sont supprimées en arrière-plan.' : ''}`);
    case 'ratelimit': return textResponse(result.limit === 0
      ? 'Quota mis à 0 : cet utilisateur ne peut plus dessiner.'
      : `Quota de cet utilisateur : ${number(result.limit)} pixels par minute.`);
    case 'size': return textResponse(result.size === null
      ? 'La grille est désormais infinie.'
      : `Grille bornée à ${number(result.size.width)} × ${number(result.size.height)} pixels.`);
  }
}
