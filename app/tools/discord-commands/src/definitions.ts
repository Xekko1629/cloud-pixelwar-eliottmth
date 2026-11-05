import { COORDINATE_LIMIT, PALETTE } from '@pixelwar/shared/grid';

// Discord API v10: only the option types needed by BOT-02 are represented.
interface OptionBase { name: string; description: string }
export interface IntegerOption extends OptionBase {
  type: 4;
  required: boolean;
  min_value: number;
  max_value: number;
  choices?: { name: string; value: number }[];
}
interface UserOption extends OptionBase { type: 6; required: true }
export interface Subcommand extends OptionBase {
  type: 1;
  options?: (IntegerOption | UserOption)[];
}
export interface Command extends OptionBase {
  type: 1;
  default_member_permissions: string | null;
  options?: (IntegerOption | Subcommand)[];
  contexts?: [0];
  integration_types?: [0];
}

export function commandDefinitions(global: boolean): Command[] {
  const commands: Command[] = [
    {
      type: 1, name: 'draw', description: 'Dessiner un pixel.',
      default_member_permissions: null,
      options: [
        coordinate('x'), coordinate('y'),
        {
          type: 4, name: 'color', description: 'Couleur de la palette.', required: true,
          min_value: 1, max_value: PALETTE.length,
          choices: PALETTE.map((hex, index) => ({ name: hex, value: index + 1 })),
        },
      ],
    },
    {
      type: 1, name: 'get', description: 'Afficher une image du dessin courant.',
      default_member_permissions: null,
    },
    {
      type: 1, name: 'snapshot', description: 'Créer un snapshot horodaté du dessin.',
      // Restrictive interpretation pending clarification of the project brief.
      default_member_permissions: '0',
    },
    {
      type: 1, name: 'admin', description: 'Administrer la grille.',
      default_member_permissions: '0',
      options: [
        { type: 1, name: 'pause', description: 'Suspendre les dessins.' },
        { type: 1, name: 'resume', description: 'Réactiver les dessins.' },
        { type: 1, name: 'clear', description: 'Effacer la grille.' },
        {
          type: 1, name: 'ratelimit', description: 'Définir un quota utilisateur en pixels par minute.',
          options: [
            { type: 6, name: 'user', description: 'Utilisateur concerné.', required: true },
            {
              type: 4, name: 'limit', description: 'Quota par minute (0 interdit de dessiner).',
              required: true, min_value: 0, max_value: Number.MAX_SAFE_INTEGER,
            },
          ],
        },
        {
          type: 1, name: 'size', description: 'Borner la grille ; sans options, la rendre infinie.',
          // Discord cannot require both or neither: BOT-08 validates this pair.
          options: ['width', 'height'].map((name): IntegerOption => ({
            type: 4, name, description: `${name === 'width' ? 'Largeur' : 'Hauteur'} en pixels.`,
            required: false, min_value: 10_000, max_value: COORDINATE_LIMIT,
          })),
        },
      ],
    },
  ];
  // These fields are only supported on globally scoped commands.
  return global ? commands.map((command) => ({ ...command, contexts: [0], integration_types: [0] })) : commands;
}

function coordinate(name: string): IntegerOption {
  return {
    type: 4, name, description: `Coordonnée ${name}.`, required: true,
    min_value: -COORDINATE_LIMIT, max_value: COORDINATE_LIMIT,
  };
}
