import { createHash } from 'node:crypto';
import { COORDINATE_LIMIT, PALETTE } from '@pixelwar/shared/grid';

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function snowflake(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value) && BigInt(value) <= 0xffffffffffffffffn;
}

// Provisional BOT-03 contract, to be reviewed with ARCH-03 before a consumer is wired.
export interface DiscordCommandEvent {
  schema_version: 1;
  event_id: string;
  correlation_id: string;
  occurred_at: string;
  source: 'discord';
  actor: { uid: string; name: string; roles: string[] };
  payload: {
    command: 'draw'; options: { x: number; y: number; color: number };
    interaction_id: string; application_id: string; guild_id: string; channel_id: string;
    interaction_token: string;
  };
}

export function commandEvent(interaction: Record<string, unknown>, applicationId: string): DiscordCommandEvent {
  const { data, member } = interaction;
  if (!snowflake(interaction.id) || interaction.application_id !== applicationId ||
      !snowflake(interaction.guild_id) || !snowflake(interaction.channel_id) ||
      typeof interaction.token !== 'string' || interaction.token.length < 1 || interaction.token.length > 4096 ||
      !record(data) || data.name !== 'draw' || data.type !== 1 ||
      !record(member) || !record(member.user) || !snowflake(member.user.id) ||
      typeof member.user.username !== 'string' || member.user.username.length < 1 || member.user.username.length > 80 ||
      !Array.isArray(member.roles) || !member.roles.every(snowflake)) {
    throw new Error('Invalid interaction');
  }
  if (!Array.isArray(data.options) || data.options.length !== 3) throw new Error('Invalid options');
  const options: Record<string, number> = {};
  for (const option of data.options) {
    if (!record(option) || !['x', 'y', 'color'].includes(String(option.name)) ||
        typeof option.name !== 'string' || option.type !== 4 || !Number.isSafeInteger(option.value) ||
        Object.hasOwn(options, option.name)) throw new Error('Invalid option');
    options[option.name] = option.value as number;
  }
  const { x, y, color } = options;
  if (Math.abs(x) > COORDINATE_LIMIT || Math.abs(y) > COORDINATE_LIMIT || color < 1 || color > PALETTE.length) {
    throw new Error('Invalid coordinates or color');
  }
  // UUID-shaped, namespaced SHA-256 (UUIDv8). Stable across delivery attempts.
  const bytes = createHash('sha256').update(`pixelwar:discord-command:v1:${applicationId}:${interaction.id}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  const eventId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return {
    schema_version: 1, event_id: eventId, correlation_id: eventId, source: 'discord',
    occurred_at: new Date(Number((BigInt(interaction.id) >> 22n) + 1420070400000n)).toISOString(),
    actor: { uid: member.user.id, name: member.user.username, roles: [...new Set(member.roles as string[])].sort() },
    payload: {
      command: 'draw', options: { x, y, color }, interaction_id: interaction.id,
      application_id: applicationId, guild_id: interaction.guild_id, channel_id: interaction.channel_id,
      interaction_token: interaction.token,
    },
  };
}
