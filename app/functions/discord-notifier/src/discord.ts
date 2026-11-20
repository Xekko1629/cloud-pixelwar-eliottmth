import { createOriginalResponseEditor, NotificationFailure } from '@pixelwar/shared/discord';
import { originalResponseContent } from './content';
import type { DiscordNotice } from './message';

// The hardened PATCH lives in @pixelwar/shared/discord, reused by the admin-worker (BOT-08).
export { NotificationFailure };
export type UpdateOriginal = (notice: DiscordNotice) => Promise<'updated' | 'expired'>;

export function createOriginalResponseUpdater(options: Parameters<typeof createOriginalResponseEditor>[0] = {}): UpdateOriginal {
  const edit = createOriginalResponseEditor(options);
  return (notice) => edit(notice.discord, originalResponseContent(notice.result));
}
