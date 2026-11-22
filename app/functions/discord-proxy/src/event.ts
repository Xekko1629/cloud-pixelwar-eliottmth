import { createHash } from 'node:crypto';
import { COORDINATE_LIMIT, PALETTE } from '@pixelwar/shared/grid';

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function snowflake(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value) && BigInt(value) <= 0xffffffffffffffffn;
}

/** Commands this proxy forwards; the others get an immediate ephemeral answer. */
export const FORWARDED_COMMANDS = ['draw', 'admin', 'get'] as const;
export type ForwardedCommand = (typeof FORWARDED_COMMANDS)[number];

/** Same names as the command-worker, which validates ranges and the width/height pair. */
export type AdminOptions = { subcommand: string } & Record<string, string | number>;
export type CommandPayload =
  | { command: 'draw'; options: { x: number; y: number; color: number } }
  | { command: 'admin'; options: AdminOptions }
  | { command: 'get'; options: Record<string, never> };

/** An interaction the user can fix: answered at once instead of failing in a worker. */
export class UserInputError extends Error {
  constructor(readonly answer: string) { super('Invalid user input'); }
}

/** The command-worker accepts 1 to 32 characters (code points), like the web-proxy. */
export const MAX_ACTOR_NAME = 32;

// discord-command v1 (docs/events.md, section 3.1).
export interface DiscordCommandEvent {
  schema_version: 1;
  event_id: string;
  correlation_id: string;
  occurred_at: string;
  source: 'discord';
  actor: { uid: string; name: string; roles: string[] };
  payload: CommandPayload & {
    interaction_id: string; application_id: string; guild_id: string; channel_id: string;
    interaction_token: string;
  };
}

// Discord sends a subcommand as one option of type 1 holding its own options.
const ADMIN_OPTIONS: Record<string, Record<string, number>> = {
  pause: {}, resume: {}, clear: {},
  ratelimit: { user: 6, limit: 4 },
  size: { width: 4, height: 4 },
};

function drawOptions(options: unknown): CommandPayload {
  if (!Array.isArray(options) || options.length !== 3) throw new Error('Invalid options');
  const values: Record<string, number> = {};
  for (const option of options) {
    if (!record(option) || !['x', 'y', 'color'].includes(String(option.name)) ||
        typeof option.name !== 'string' || option.type !== 4 || !Number.isSafeInteger(option.value) ||
        Object.hasOwn(values, option.name)) throw new Error('Invalid option');
    values[option.name] = option.value as number;
  }
  const { x, y, color } = values;
  if (Math.abs(x) > COORDINATE_LIMIT || Math.abs(y) > COORDINATE_LIMIT || color < 1 || color > PALETTE.length) {
    throw new Error('Invalid coordinates or color');
  }
  return { command: 'draw', options: { x, y, color } };
}

function adminOptions(options: unknown): CommandPayload {
  if (!Array.isArray(options) || options.length !== 1 || !record(options[0]) || options[0].type !== 1 ||
      typeof options[0].name !== 'string' || !Object.hasOwn(ADMIN_OPTIONS, options[0].name)) throw new Error('Invalid subcommand');
  const subcommand = options[0].name;
  const allowed = ADMIN_OPTIONS[subcommand];
  const nested = options[0].options ?? [];
  if (!Array.isArray(nested) || nested.length > Object.keys(allowed).length) throw new Error('Invalid options');
  const values: AdminOptions = { subcommand };
  for (const option of nested) {
    if (!record(option) || typeof option.name !== 'string' || !Object.hasOwn(allowed, option.name) ||
        option.type !== allowed[option.name] || Object.hasOwn(values, option.name)) throw new Error('Invalid option');
    if (option.type === 6 ? !snowflake(option.value) : !Number.isSafeInteger(option.value)) throw new Error('Invalid option');
    values[option.name] = option.value as string | number;
  }
  if (subcommand === 'ratelimit' && nested.length !== 2) throw new Error('Invalid options');
  // Discord cannot require "both or neither": answer the user rather than fail in a worker.
  if (subcommand === 'size' && nested.length === 1) {
    throw new UserInputError('Indique `width` et `height` ensemble, ou aucun des deux pour une grille infinie.');
  }
  return { command: 'admin', options: values };
}

// /get has no option: Discord omits the field (an empty list is accepted too).
function getOptions(options: unknown): CommandPayload {
  if (options !== undefined && !(Array.isArray(options) && options.length === 0)) throw new Error('Invalid options');
  return { command: 'get', options: {} };
}

export function commandEvent(interaction: Record<string, unknown>, applicationId: string): DiscordCommandEvent {
  const { data, member } = interaction;
  if (!snowflake(interaction.id) || interaction.application_id !== applicationId ||
      !snowflake(interaction.guild_id) || !snowflake(interaction.channel_id) ||
      typeof interaction.token !== 'string' || interaction.token.length < 1 || interaction.token.length > 4096 ||
      !record(data) || !FORWARDED_COMMANDS.includes(data.name as ForwardedCommand) || data.type !== 1 ||
      !record(member) || !record(member.user) || !snowflake(member.user.id) ||
      typeof member.user.username !== 'string' || member.user.username.length < 1 || member.user.username.length > 80 ||
      !Array.isArray(member.roles) || !member.roles.every(snowflake)) {
    throw new Error('Invalid interaction');
  }
  const command = data.name === 'admin' ? adminOptions(data.options)
    : data.name === 'get' ? getOptions(data.options) : drawOptions(data.options);
  // UUID-shaped, namespaced SHA-256 (UUIDv8). Stable across delivery attempts.
  const bytes = createHash('sha256').update(`pixelwar:discord-command:v1:${applicationId}:${interaction.id}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  const eventId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return {
    schema_version: 1, event_id: eventId, correlation_id: eventId, source: 'discord',
    occurred_at: new Date(Number((BigInt(interaction.id) >> 22n) + 1420070400000n)).toISOString(),
    actor: {
      uid: member.user.id, name: Array.from(member.user.username).slice(0, MAX_ACTOR_NAME).join(''),
      roles: [...new Set(member.roles as string[])].sort(),
    },
    payload: {
      ...command, interaction_id: interaction.id,
      application_id: applicationId, guild_id: interaction.guild_id, channel_id: interaction.channel_id,
      interaction_token: interaction.token,
    },
  };
}
