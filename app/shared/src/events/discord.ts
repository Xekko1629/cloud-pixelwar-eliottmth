/** Proposed ARCH-03 contracts. No producer/consumer implementation dependency. */
export type AdminCommand =
  | { subcommand: 'pause' | 'resume' | 'clear' }
  | { subcommand: 'ratelimit'; user: string; limit: number }
  | { subcommand: 'size'; width?: number; height?: number };

export interface DiscordContext {
  application_id: string;
  interaction_id: string;
  channel_id: string;
  guild_id: string;
  interaction_token: string;
}

export type OutputType = 'pixel-draw' | 'render-requested' | 'snapshot-requested' | 'admin-requested' | 'command-rejected';
interface Envelope {
  schema_version: 1;
  event_id: string;
  correlation_id: string;
  occurred_at: string;
  source: 'discord';
  actor: { uid: string; name: string };
}

export type RoutedDiscordEvent = Envelope & (
  | { type: 'pixel-draw'; payload: { pixels: { x: number; y: number; color: number }[]; discord: DiscordContext } }
  | { type: 'render-requested' | 'snapshot-requested'; payload: { discord: DiscordContext } }
  // Only admin-requested keeps the Discord roles: the admin-worker re-checks the allow-list (BOT-08).
  | { type: 'admin-requested'; actor: { uid: string; name: string; roles: string[] }; payload: { options: AdminCommand; discord: DiscordContext } }
  | { type: 'command-rejected'; payload: { command: 'admin' | 'snapshot'; reason: 'unauthorized'; discord: DiscordContext } }
);
