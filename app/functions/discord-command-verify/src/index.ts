import type { HttpFunction } from '@google-cloud/functions-framework';
import { InvalidMessage, MAX_PUSH_BYTES, snowflake, validatePush } from './message';

interface Options {
  environment?: string;
  subscription?: string;
  applicationId?: string;
  write?: (line: string) => void;
}

/** Temporary logs-only consumer. IAM/OIDC is enforced by the private service, not this parser. */
export function createDiscordCommandVerifyHandler(options: Options): HttpFunction {
  const write = options.write ?? ((line: string) => { process.stdout.write(line); });
  return (req, res): void => {
    if (options.environment !== 'dev' || !snowflake(options.applicationId) ||
        !options.subscription || !/^projects\/[a-z][a-z0-9-]+\/subscriptions\/[a-z][a-z0-9-]+$/.test(options.subscription)) {
      res.status(503).json({ error: 'Verification unavailable.' }); return;
    }
    if (req.path !== '/') { res.status(404).json({ error: 'Not found.' }); return; }
    if (req.method !== 'POST') { res.set('Allow', 'POST').status(405).json({ error: 'Method not allowed.' }); return; }
    // Functions Framework has already parsed JSON; raw size still bounds our decode/validation work.
    if (!Buffer.isBuffer(req.rawBody) || req.rawBody.length > MAX_PUSH_BYTES) {
      res.status(413).json({ error: 'Invalid push body size.' }); return;
    }
    try {
      const identifiers = validatePush(req.body, options.subscription, options.applicationId);
      // Explicit allowlist: no body, token, user, attributes, or Error can reach the log.
      write(`${JSON.stringify({
        severity: 'INFO', function: 'discord-command-verify', event_type: 'discord.command.verify.consumed',
        ...identifiers,
      })}\n`);
    } catch (error) {
      if (!(error instanceof InvalidMessage)) {
        res.status(503).json({ error: 'Verification unavailable.' }); return;
      }
      write(`${JSON.stringify({
        severity: 'WARNING', function: 'discord-command-verify', event_type: 'discord.command.verify.rejected', reason: error.reason,
      })}\n`);
      res.status(400).json({ error: 'Invalid Pub/Sub message.' }); return;
    }
    res.status(204).send();
  };
}

export const handleDiscordCommandVerify = createDiscordCommandVerifyHandler({
  environment: process.env.APP_ENV, subscription: process.env.DISCORD_VERIFY_SUBSCRIPTION,
  applicationId: process.env.DISCORD_APPLICATION_ID,
});
